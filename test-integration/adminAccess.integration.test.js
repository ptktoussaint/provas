const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Perfis do painel: administrador principal (acesso completo) e restrito
// (sem Logins/senhas, Segurança & auditoria, Integração BotGhost e
// Mensagens do Bot). Tudo conferido pela API, como um navegador faria —
// inclusive chamadas "manuais" que o menu não oferece.

let db;
let site;
let User;

before(async () => {
  db = await H.setupDb();
  User = require('../models/User');
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  site = await H.startSite();
});
afterEach(async () => { await site.close(); });

async function login(username, password) {
  const call = site.client();
  const r = await call('POST', '/api/admin/login', { username, password });
  return { call, r };
}

// O login atual do dono, gravado antes dos perfis existirem (role 'admin').
async function ownerSession() {
  await H.seedAdmin('dono', 'senha-do-dono-123', 'admin');
  await require('../lib/adminUsers').migrateAdminRoles();
  const { call, r } = await login('dono', 'senha-do-dono-123');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return call;
}

async function createRestricted(owner, extra = {}) {
  const r = await owner('POST', '/api/admin/users', { displayName: 'Fulano Avaliador', username: 'fulano', password: 'senha-fulano-123', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user;
}

function assertNoSecrets(body) {
  const json = JSON.stringify(body);
  assert.ok(!/passwordHash|\$argon2/.test(json), 'nunca devolve senha/hash');
  assert.ok(!json.includes('senha-fulano-123'));
}

test('migração: login antigo (role "admin") vira administrador principal com acesso completo', async () => {
  const owner = await ownerSession();
  const me = await owner('GET', '/api/admin/me');
  assert.equal(me.body.admin.role, 'primary');
  assert.deepEqual(me.body.admin.permissions, { users: true, security: true, integration: true, templates: true });
  assert.equal((await User.findOne({ username: 'dono' }).lean()).role, 'primary');
  for (const path of ['/api/admin/users', '/api/admin/security-logs', '/api/admin/storage-report', '/api/admin/integration/status', '/api/admin/integration/templates', '/api/admin/storage/cleanup/current']) {
    assert.equal((await owner('GET', path)).status, 200, path);
  }
  // Idempotente e nunca rebaixa.
  await require('../lib/adminUsers').migrateAdminRoles();
  assert.equal((await User.findOne({ username: 'dono' }).lean()).role, 'primary');
});

test('principal cria acesso restrito (perfil forçado), senha só como hash argon2, nada sensível na resposta', async () => {
  const owner = await ownerSession();
  const user = await createRestricted(owner, { role: 'primary', permissions: { users: true } });
  assert.equal(user.role, 'restricted', 'perfil enviado pelo navegador é ignorado');
  assert.equal(user.active, true);
  const created = await owner('GET', '/api/admin/users');
  assertNoSecrets(created.body);
  const raw = await User.findOne({ username: 'fulano' }).lean();
  assert.match(raw.passwordHash, /^\$argon2id\$/);
  assert.equal(raw.role, 'restricted');
  // Login repetido (sem diferenciar maiúsculas) → 409.
  const dup = await owner('POST', '/api/admin/users', { displayName: 'Outro', username: 'FULANO', password: 'outra-senha-123' });
  assert.equal(dup.status, 409);
  // Validações.
  assert.equal((await owner('POST', '/api/admin/users', { displayName: 'X', username: 'ab', password: 'senha-12345' })).status, 400);
  assert.equal((await owner('POST', '/api/admin/users', { displayName: 'X', username: 'beltrano', password: 'curta' })).status, 400);
  assert.equal((await owner('POST', '/api/admin/users', { displayName: '', username: 'beltrano', password: 'senha-12345' })).status, 400);
});

test('conta restrita: usa as funções permitidas e é bloqueada (403, sem dados) nas quatro áreas e nas operações de conta', async () => {
  const owner = await ownerSession();
  const me = await createRestricted(owner);
  const { call: restricted, r } = await login('fulano', 'senha-fulano-123');
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'restricted');
  const who = await restricted('GET', '/api/admin/me');
  assert.deepEqual(who.body.admin.permissions, { users: false, security: false, integration: false, templates: false });

  // Permitido: provas, questões, salas, resultados, dashboard, configurações.
  const exam = await restricted('POST', '/api/admin/exams', { name: 'Prova Major', group: 'DAFP', questionCount: 5, pointsPerQuestion: 2 });
  assert.equal(exam.status, 201, JSON.stringify(exam.body));
  for (const path of ['/api/admin/exams', '/api/admin/rooms', '/api/admin/results', '/api/admin/dashboard', '/api/admin/settings', '/api/admin/rooms/live']) {
    assert.equal((await restricted('GET', path)).status, 200, path);
  }
  const room = await restricted('POST', '/api/admin/rooms', { examId: exam.body.exam._id, roomLabel: 'Sala 1', studentName: 'Aluno' });
  assert.equal(room.status, 201);

  // Bloqueado: menu escondido NÃO é a proteção — a API recusa.
  const blocked = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { displayName: 'Novo', username: 'novo', password: 'senha-novo-123' }],
    ['PUT', `/api/admin/users/${me.id}`, { role: 'primary' }],
    ['POST', `/api/admin/users/${me.id}/active`, { active: true }],
    ['POST', `/api/admin/users/${me.id}/password`, { password: 'outra-senha-123' }],
    ['GET', '/api/admin/security-logs'],
    ['GET', '/api/admin/exam-events'],
    ['GET', '/api/admin/storage-report'],
    ['GET', '/api/admin/storage/cluster'],
    ['POST', '/api/admin/storage/cleanup/preview', { days: 30 }],
    ['POST', '/api/admin/storage/cleanup/execute', { previewId: 'x', cutoff: new Date().toISOString() }],
    ['GET', '/api/admin/storage/cleanup/current'],
    ['GET', '/api/admin/integration/status'],
    ['GET', '/api/admin/integration/config'],
    ['PUT', '/api/admin/integration/config', { operatorIds: {} }],
    ['GET', '/api/admin/integration/notifications'],
    ['POST', '/api/admin/integration/panel/update', {}],
    ['GET', '/api/admin/integration/promotions'],
    ['GET', '/api/admin/integration/templates'],
    ['GET', '/api/admin/integration/templates/room_created'],
    ['PUT', '/api/admin/integration/templates/room_created/draft', { draft: {} }],
    ['POST', '/api/admin/integration/templates/room_created/publish', {}],
  ];
  for (const [method, path, body] of blocked) {
    const res = await restricted(method, path, body);
    assert.equal(res.status, 403, `${method} ${path} → ${res.status}`);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'success'], `${method} ${path}: sem dados da área`);
  }
  // Continua restrito, ativo e com a mesma senha.
  const raw = await User.findById(me.id).lean();
  assert.equal(raw.role, 'restricted');
  assert.equal(await User.countDocuments(), 2);
});

test('administrador principal não pode ser editado, desativado nem ter a senha trocada por este fluxo', async () => {
  const owner = await ownerSession();
  const primary = await User.findOne({ username: 'dono' }).lean();
  assert.equal((await owner('PUT', `/api/admin/users/${primary._id}`, { displayName: 'X' })).status, 403);
  assert.equal((await owner('POST', `/api/admin/users/${primary._id}/active`, { active: false })).status, 403);
  assert.equal((await owner('POST', `/api/admin/users/${primary._id}/password`, { password: 'nova-senha-123' })).status, 403);
  const after = await User.findById(primary._id).lean();
  assert.equal(after.active, true);
  assert.equal(after.role, 'primary');
  // Perfil de conta restrita também não muda.
  const user = await createRestricted(owner);
  assert.equal((await owner('PUT', `/api/admin/users/${user.id}`, { role: 'primary' })).status, 403);
  assert.equal((await User.findById(user.id).lean()).role, 'restricted');
  assert.equal((await owner('GET', '/api/admin/me')).status, 200, 'principal segue com acesso');
});

test('desativar derruba a sessão aberta e impede novo login; reativar devolve o acesso', async () => {
  const owner = await ownerSession();
  const user = await createRestricted(owner);
  const { call: restricted } = await login('fulano', 'senha-fulano-123');
  assert.equal((await restricted('GET', '/api/admin/exams')).status, 200);

  const off = await owner('POST', `/api/admin/users/${user.id}/active`, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.user.active, false);
  const revoked = await restricted('GET', '/api/admin/exams');
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'session_revoked');
  assert.equal((await restricted('GET', '/api/admin/me')).status, 401, 'sessão continua derrubada');
  const again = await login('fulano', 'senha-fulano-123');
  assert.equal(again.r.status, 403);
  assert.match(again.r.body.message, /desativado/);
  // Senha errada numa conta desativada não revela que ela existe.
  assert.equal((await login('fulano', 'errada-errada')).r.status, 401);

  assert.equal((await owner('POST', `/api/admin/users/${user.id}/active`, { active: true })).status, 200);
  const back = await login('fulano', 'senha-fulano-123');
  assert.equal(back.r.status, 200);
  assert.equal((await back.call('GET', '/api/admin/exams')).status, 200);
});

test('redefinir senha invalida as sessões abertas; senha antiga deixa de funcionar', async () => {
  const owner = await ownerSession();
  const user = await createRestricted(owner);
  const { call: restricted } = await login('fulano', 'senha-fulano-123');
  const reset = await owner('POST', `/api/admin/users/${user.id}/password`, { password: 'senha-nova-456' });
  assert.equal(reset.status, 200);
  assertNoSecrets(reset.body);
  assert.equal((await restricted('GET', '/api/admin/exams')).status, 401);
  assert.equal((await login('fulano', 'senha-fulano-123')).r.status, 401);
  assert.equal((await login('fulano', 'senha-nova-456')).r.status, 200);
  // Editar nome/login não derruba nada e não mexe no perfil.
  const edit = await owner('PUT', `/api/admin/users/${user.id}`, { displayName: 'Fulano de Tal', username: 'fulano.tal' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.user.username, 'fulano.tal');
  assert.equal((await login('fulano.tal', 'senha-nova-456')).r.status, 200);
});

test('segurança das sessões: pedido sem sessão = 401; papel nunca vem do navegador', async () => {
  const anon = site.client();
  assert.equal((await anon('GET', '/api/admin/exams')).status, 401);
  assert.equal((await anon('GET', '/api/admin/users')).status, 401);
  const owner = await ownerSession();
  const user = await createRestricted(owner);
  const { call: restricted } = await login('fulano', 'senha-fulano-123');
  // Tentativas de se promover por campos enviados.
  await restricted('PUT', '/api/admin/settings', { role: 'primary', permissions: { users: true } });
  assert.equal((await restricted('GET', '/api/admin/users')).status, 403);
  assert.equal((await User.findById(user.id).lean()).role, 'restricted');
  // Conta apagada do banco = sessão inválida.
  await User.deleteOne({ _id: user.id });
  assert.equal((await restricted('GET', '/api/admin/exams')).status, 401);
});

test('sockets do painel: conta desativada é recusada na conexão em tempo real', async () => {
  const owner = await ownerSession();
  const user = await createRestricted(owner);
  const adminUsers = require('../lib/adminUsers');
  const raw = await User.findById(user.id).lean();
  const sessionAdmin = adminUsers.sessionPayload(raw);
  assert.ok(await adminUsers.loadSessionUser(sessionAdmin));
  await owner('POST', `/api/admin/users/${user.id}/active`, { active: false });
  assert.equal(await adminUsers.loadSessionUser(sessionAdmin), null);
  // disconnectAdminSockets derruba só os sockets dessa conta.
  const events = [];
  const mk = (id) => ({ request: { session: { admin: { id } } }, emit: (e) => events.push([id, e]), disconnect: () => events.push([id, 'disconnect']) });
  const io = { of: () => ({ sockets: new Map([['a', mk(user.id)], ['b', mk('outro')]]) }) };
  assert.equal(adminUsers.disconnectAdminSockets(io, user.id), 1);
  assert.deepEqual(events, [[user.id, 'auth:error'], [user.id, 'disconnect']]);
});
