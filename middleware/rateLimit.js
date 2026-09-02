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

const answerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas requisições — aguarde um instante.' },
});

const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { adminLoginLimiter, identifyLimiter, answerLimiter, adminApiLimiter };
