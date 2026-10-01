const argon2 = require('argon2');
const User = require('../models/User');

// Contas do painel administrativo: perfil principal (acesso completo) e
// restrito. Toda decisão de permissão sai daqui e do usuário GRAVADO no
// banco — nunca do que o navegador manda.

const PRIMARY = 'primary';
const RESTRICTED = 'restricted';

// Áreas que só o administrador principal acessa (menu, páginas e API).
const PRIMARY_ONLY_AREAS = ['users', 'security', 'integration', 'templates'];

function isPrimaryRole(role) {
  // 'admin' = contas criadas antes dos perfis (o login atual do dono).
  return role === PRIMARY || role === 'admin';
}

function roleOf(user) {
  return isPrimaryRole(user && user.role) ? PRIMARY : RESTRICTED;
}

function permissionsOf(user) {
  const primary = roleOf(user) === PRIMARY;
  return Object.fromEntries(PRIMARY_ONLY_AREAS.map((a) => [a, primary]));
}

// Converte as contas antigas (role 'admin' ou sem role) em administrador
// principal. Idempotente; roda em cada início do site. Nunca rebaixa nada.
async function migrateAdminRoles() {
  const r = await User.updateMany({ $or: [{ role: 'admin' }, { role: { $exists: false } }, { role: null }] }, { $set: { role: PRIMARY } });
  return r.modifiedCount || 0;
}

function sessionPayload(user) {
  return { id: String(user._id), username: user.username, role: roleOf(user), sv: user.sessionVersion || 0 };
}

// Confere a sessão contra o banco a cada pedido: conta apagada, desativada
// ou com senha redefinida (sessionVersion maior) perde o acesso na hora.
async function loadSessionUser(sessionAdmin) {
  if (!sessionAdmin || !sessionAdmin.id) return null;
  let user;
  try {
    user = await User.findById(sessionAdmin.id).select('-passwordHash').lean();
  } catch (_) { return null; }
  if (!user || user.active === false) return null;
  if ((user.sessionVersion || 0) !== (sessionAdmin.sv || 0)) return null;
  return user;
}

// O que pode ir para o navegador: NUNCA senha nem hash.
function publicUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName || null,
    role: roleOf(user),
    active: user.active !== false,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    passwordChangedAt: user.passwordChangedAt || null,
  };
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateUsername(value) {
  const username = String(value == null ? '' : value).trim();
  if (!USERNAME_RE.test(username)) throw badRequest('Login inválido: use de 3 a 40 caracteres (letras, números, ponto, hífen ou sublinhado), sem espaços.');
  return username;
}

function validateDisplayName(value) {
  const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Informe o nome da pessoa.');
  if (name.length > 80) throw badRequest('Nome: no máximo 80 caracteres.');
  return name;
}

function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw badRequest('A senha precisa ter pelo menos 8 caracteres.');
  if (password.length > 200) throw badRequest('Senha longa demais (máximo 200 caracteres).');
  return password;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertUsernameFree(username, exceptId = null) {
  const filter = { username: new RegExp(`^${escapeRegex(username)}$`, 'i') };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await User.exists(filter)) throw badRequest('Este login já está em uso.', 409);
}

async function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function listUsers() {
  const users = await User.find().select('-passwordHash').sort({ createdAt: 1 }).lean();
  return users.map(publicUser);
}

// Todo acesso criado por este fluxo é RESTRITO — não há parâmetro de perfil.
async function createRestrictedUser({ displayName, username, password }, actor) {
  const data = { displayName: validateDisplayName(displayName), username: validateUsername(username) };
  const pass = validatePassword(password);
  await assertUsernameFree(data.username);
  try {
    const user = await User.create({ ...data, passwordHash: await hashPassword(pass), role: RESTRICTED, active: true, createdBy: actor, passwordChangedAt: new Date() });
    return publicUser(user);
  } catch (err) {
    if (err && err.code === 11000) throw badRequest('Este login já está em uso.', 409);
    throw err;
  }
}

// Só contas restritas podem ser alteradas por aqui: o administrador
// principal nunca é editado, desativado nem tem a senha trocada por este
// fluxo — assim o site nunca fica sem administrador principal ativo.
async function loadRestricted(id) {
  let user = null;
  try { user = await User.findById(id); } catch (_) { /* id inválido */ }
  if (!user) throw badRequest('Conta não encontrada.', 404);
  if (roleOf(user) !== RESTRICTED) throw badRequest('O administrador principal não pode ser alterado por aqui.', 403);
  return user;
}

async function updateRestrictedUser(id, body = {}) {
  const user = await loadRestricted(id);
  if ('role' in body || 'permissions' in body) throw badRequest('O perfil não pode ser alterado: contas criadas aqui são sempre restritas.', 403);
  if ('displayName' in body) user.displayName = validateDisplayName(body.displayName);
  if ('username' in body) {
    const username = validateUsername(body.username);
    if (username !== user.username) {
      await assertUsernameFree(username, user._id);
      user.username = username;
    }
  }
  await user.save();
  return publicUser(user);
}

async function resetRestrictedPassword(id, password) {
  const user = await loadRestricted(id);
  const pass = validatePassword(password);
  user.passwordHash = await hashPassword(pass);
  user.passwordChangedAt = new Date();
  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();
  return publicUser(user);
}

async function setRestrictedActive(id, active) {
  const user = await loadRestricted(id);
  const next = Boolean(active);
  if (user.active !== next) {
    user.active = next;
    // Desativar derruba as sessões abertas; reativar não ressuscita nenhuma.
    if (!next) user.sessionVersion = (user.sessionVersion || 0) + 1;
    await user.save();
  }
  return publicUser(user);
}

// Encerra na hora os sockets (tempo real) abertos por uma conta.
function disconnectAdminSockets(io, userId) {
  if (!io) return 0;
  let n = 0;
  for (const socket of io.of('/').sockets.values()) {
    const admin = socket.request && socket.request.session && socket.request.session.admin;
    if (admin && admin.id === String(userId)) {
      socket.emit('auth:error', { message: 'Sessão encerrada.' });
      socket.disconnect(true);
      n += 1;
    }
  }
  return n;
}

module.exports = {
  PRIMARY,
  RESTRICTED,
  PRIMARY_ONLY_AREAS,
  isPrimaryRole,
  roleOf,
  permissionsOf,
  migrateAdminRoles,
  sessionPayload,
  loadSessionUser,
  publicUser,
  listUsers,
  createRestrictedUser,
  updateRestrictedUser,
  resetRestrictedPassword,
  setRestrictedActive,
  disconnectAdminSockets,
  validatePassword,
};
