// Toda autorização é verificada aqui, no servidor — nunca confiando em
// dados enviados pelo cliente sobre seu próprio papel (requisito #42).

// Admin: a sessão só guarda QUEM é; o perfil (principal/restrito), se a
// conta continua ativa e se a sessão ainda vale (senha redefinida/conta
// desativada sobem sessionVersion) são lidos do banco a cada pedido.
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ success: false, message: 'Sessão de administrador necessária.' });
  }
  const { loadSessionUser, roleOf, permissionsOf } = require('../lib/adminUsers');
  const user = await loadSessionUser(req.session.admin);
  if (!user) {
    req.session.admin = null;
    return res.status(401).json({ success: false, code: 'session_revoked', message: 'Sessão encerrada. Entre novamente.' });
  }
  req.adminUser = { id: String(user._id), username: user.username, displayName: user.displayName || null, role: roleOf(user), permissions: permissionsOf(user) };
  // Mantém o nome atualizado (usado como autor nas auditorias).
  req.session.admin.username = user.username;
  req.session.admin.role = req.adminUser.role;
  next();
}

// Áreas exclusivas do administrador principal (Logins/senhas, Segurança &
// auditoria, Integração BotGhost, Mensagens do Bot). Sempre DEPOIS de
// requireAdmin. Não devolve nenhum dado da área.
function requirePrimary(req, res, next) {
  if (!req.adminUser || req.adminUser.role !== 'primary') {
    return res.status(403).json({ success: false, code: 'forbidden', message: 'Acesso negado: esta área é exclusiva do administrador principal.' });
  }
  next();
}

function requireStudentSession(req, res, next) {
  if (!req.session || !req.session.student || !req.session.student.roomId) {
    return res.status(401).json({ success: false, message: 'Sessão expirada. Acesse novamente pelo link da sua sala.' });
  }
  next();
}

function requireProctorSession(req, res, next) {
  if (!req.session || !req.session.proctor || !req.session.proctor.roomId) {
    return res.status(401).json({ success: false, message: 'Sessão expirada. Acesse novamente pelo link do fiscal.' });
  }
  next();
}

module.exports = { requireAdmin, requirePrimary, requireStudentSession, requireProctorSession };
