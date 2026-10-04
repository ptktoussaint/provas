require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

// Lista de servidores ICE separados por vírgula (STUN_URLS / TURN_URLS):
// tira espaços, ignora vazios e repetidos e descarta o que não começa com o
// esquema certo — um único endereço inválido faria o navegador recusar a
// conexão WebRTC inteira (RTCPeerConnection lança erro). Lista vazia ⇒
// padrão (STUN do Google; TURN nenhum).
function parseIceUrls(name, schemes, fallback) {
  const seen = new Set();
  const out = [];
  for (const raw of String(process.env[name] || '').split(',')) {
    const url = raw.trim();
    if (!url) continue;
    if (!schemes.some((s) => url.toLowerCase().startsWith(s))) {
      console.warn(`[env] ${name}: endereço ignorado (precisa começar com ${schemes.join(' ou ')}): ${url.slice(0, 80)}`);
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out.length ? out : fallback;
}

function publicBaseUrlFromEnv() {
  const value = (process.env.PUBLIC_BASE_URL || '').trim();
  if (!value) return null;
  if (!/^https?:\/\/[^/\s]+/i.test(value)) {
    console.warn('[env] PUBLIC_BASE_URL ignorada: precisa começar com http:// ou https://');
    return null;
  }
  return value;
}

module.exports = {
  isProduction,
  port: parseInt(process.env.PORT || '3000', 10),
  mongoUri: required('MONGODB_URI'),
  // Banco explícito (opcional). Quando definido, vale mais que o banco escrito
  // na URI — garante que o site use o banco certo (ex.: "test", onde estão os
  // dados) mesmo que a URI venha sem /<banco>. Sem os dois, o driver usa
  // "test" por padrão.
  mongoDbName: (process.env.MONGODB_DB_NAME || '').trim() || null,
  sessionSecret: required('SESSION_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  stunUrls: parseIceUrls('STUN_URLS', ['stun:', 'stuns:'], [DEFAULT_STUN_URL]),
  turnUrls: parseIceUrls('TURN_URLS', ['turn:', 'turns:'], []),
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
  // PUBLIC_BASE_URL (opcional) substitui essa URL quando o site usa um
  // domínio próprio; só é aceita se começar com http:// ou https://.
  publicBaseUrl: (publicBaseUrlFromEnv() || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/+$/, ''),
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
