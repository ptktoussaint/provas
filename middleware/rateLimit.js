const rateLimit = require('express-rate-limit');

// Limites conservadores em pontos sensíveis (login, identificação por
// token, submissão de resposta) — requisito #47.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const identifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas tentativas. Aguarde alguns minutos.' },
});

// Depois de identificado, a sessão já sabe a sala do aluno — contar por
// sala em vez de por IP evita que várias provas simultâneas atrás do
// mesmo IP (ex.: mesma rede/NAT) compartilhem sem querer um único balde de
// limite. Some com o IP como chave de fallback só para requisições sem
// sessão (não deveria acontecer, pois a rota exige requireStudentSession).
const answerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas requisições — aguarde um instante.' },
  keyGenerator: (req) => req.session?.student?.roomId || req.ip,
});

const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { adminLoginLimiter, identifyLimiter, answerLimiter, adminApiLimiter };
