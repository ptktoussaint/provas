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
  // O Render já define RENDER_EXTERNAL_URL (https://<serviço>.onrender.com)
  // em todo serviço web — é a URL pública usada nos links que o bot do
  // Discord entrega. Fora do Render (teste local), cai no localhost.
  publicBaseUrl: (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/+$/, ''),
  discord: {
    enabled: process.env.DISCORD_ENABLED === 'true',
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    clientId: process.env.DISCORD_CLIENT_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null,
  },
};
