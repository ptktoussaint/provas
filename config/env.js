require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  isProduction,
  port: parseInt(process.env.PORT || '3000', 10),
  mongoUri: required('MONGODB_URI'),
  sessionSecret: required('SESSION_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnUrls: (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnSecret: process.env.TURN_SECRET || null,
  turnCredentialTtlSeconds: parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS || '43200', 10),
  // Credenciais estáticas — alternativa mais simples ao TURN_SECRET (HMAC
  // efêmero) para quem está usando um provedor de TURN gratuito que só
  // fornece usuário/senha fixos (ex.: Open Relay Project/Metered).
  turnUsername: process.env.TURN_USERNAME || null,
  turnCredential: process.env.TURN_CREDENTIAL || null,
  seedAdminUsername: process.env.SEED_ADMIN_USERNAME || null,
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || null,
};
