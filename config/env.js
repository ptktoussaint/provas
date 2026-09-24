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
  // em todo serviço web — é a URL pública usada nos links que a integração
  // com o BotGhost entrega. Fora do Render (teste local), cai no localhost.
  publicBaseUrl: (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/+$/, ''),
  // Integração com o bot existente hospedado no BotGhost. O site NÃO conecta
  // no Discord (sem Gateway, sem token do bot aqui): o BotGhost chama a API
  // /api/integrations/botghost com BOTGHOST_SITE_API_KEY, e o site avisa o
  // BotGhost pelo módulo Webhooks (BOTGHOST_WEBHOOK_URL + _API_KEY).
  botghost: {
    enabled: process.env.BOTGHOST_INTEGRATION_ENABLED === 'true',
    siteApiKey: process.env.BOTGHOST_SITE_API_KEY || null,
    allowedGuildId: process.env.BOTGHOST_ALLOWED_GUILD_ID || null,
    notificationsEnabled: process.env.BOTGHOST_NOTIFICATIONS_ENABLED === 'true',
    webhookUrl: process.env.BOTGHOST_WEBHOOK_URL || null,
    webhookApiKey: process.env.BOTGHOST_WEBHOOK_API_KEY || null,
  },
};
