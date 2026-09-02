// Toda autorização é verificada aqui, no servidor — nunca confiando em
// dados enviados pelo cliente sobre seu próprio papel (requisito #42).

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ success: false, message: 'Sessão de administrador necessária.' });
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

module.exports = { requireAdmin, requireStudentSession, requireProctorSession };
