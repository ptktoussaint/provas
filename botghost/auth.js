const crypto = require('crypto');
const { ApiError, reply } = require('./http');
const { isSnowflake } = require('../lib/discordIds');
const { logSecurityEvent } = require('../lib/securityLog');
const { userText } = require('./format');
const configStore = require('./configStore');

// Autenticação máquina-a-máquina do BotGhost. Sem sessão/cookie: a chave
// BOTGHOST_SITE_API_KEY (só no ambiente) vai no header
// "Authorization: Bearer <chave>". Sem chave configurada = integração
// fechada. A chave autentica o BotGhost, NÃO o operador: o operador é o
// actorDiscordId que o BotGhost tira da interação real ({user_id}) e que o
// site confere na lista de IDs autorizados por ação (configurada no admin).

const MIN_KEY_LENGTH = 32;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

const lastLog = new Map();
async function logThrottled(type, key, meta) {
  const now = Date.now();
  if (now - (lastLog.get(key) || 0) < 60000) return;
  lastLog.set(key, now);
  if (lastLog.size > 5000) lastLog.clear();
  await logSecurityEvent(type, { meta });
}

function createKeyAuth(getEnv) {
  return function botghostKeyAuth(req, res, next) {
    const env = getEnv();
    if (!env.enabled) return reply(res, 503, 'integration_disabled', 'Integração BotGhost desligada no site.');
    if (!env.siteApiKey || env.siteApiKey.length < MIN_KEY_LENGTH) {
      return reply(res, 503, 'integration_not_configured', 'Chave de integração do site não configurada (BOTGHOST_SITE_API_KEY).');
    }
    const header = String(req.get('authorization') || '');
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m || !safeEqual(m[1], env.siteApiKey)) {
      logThrottled('botghost_unauthorized', `ip:${req.ip}`, { ip: req.ip, route: req.path }).catch(() => {});
      return reply(res, 401, 'unauthorized', 'Chave de integração ausente ou inválida.');
    }
    configStore.recordStatus({ lastAuthAt: new Date(), lastAuthRoute: `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}` }).catch(() => {});
    return next();
  };
}

// Confere servidor, canal (se configurado) e operador para a ação. Os IDs
// vêm do contexto real da interação no BotGhost ({server_id}, {user_id},
// {channel_id}), nunca de campos digitados.
async function resolveActor(req, action, getEnv) {
  const env = getEnv();
  const src = req.method === 'GET' ? req.query : (req.body || {});
  // IDs do Discord só como TEXTO: número no JSON perde precisão (vira outro
  // ID) — recusar em vez de arredondar.
  for (const name of ['guildId', 'actorDiscordId', 'channelId']) {
    if (src[name] != null && typeof src[name] !== 'string') {
      throw new ApiError(400, 'invalid_field', `${name} precisa ir entre aspas no JSON (texto), nunca como número.`, { field: name });
    }
  }
  const guildId = String(src.guildId || '').trim();
  const actorDiscordId = String(src.actorDiscordId || '').trim();
  const channelId = String(src.channelId || '').trim();
  if (!env.allowedGuildId) throw new ApiError(503, 'integration_not_configured', 'Servidor autorizado não configurado (BOTGHOST_ALLOWED_GUILD_ID).');
  if (!isSnowflake(guildId)) throw new ApiError(400, 'invalid_field', 'guildId inválido (use {server_id}).', { field: 'guildId' });
  if (guildId !== env.allowedGuildId) {
    await logThrottled('botghost_guild_denied', `g:${guildId}`, { guildId, route: req.path });
    throw new ApiError(403, 'guild_not_allowed', 'Este servidor não está autorizado.');
  }
  if (!isSnowflake(actorDiscordId)) throw new ApiError(400, 'invalid_field', 'actorDiscordId inválido (use {user_id}).', { field: 'actorDiscordId' });
  const config = await configStore.getConfig();
  if (config.channels.panel) {
    if (!isSnowflake(channelId)) throw new ApiError(400, 'invalid_field', 'channelId obrigatório (use {channel_id}).', { field: 'channelId' });
    if (channelId !== config.channels.panel) {
      await logThrottled('botghost_channel_denied', `c:${actorDiscordId}:${channelId}`, { actorDiscordId, channelId, route: req.path });
      throw new ApiError(403, 'wrong_channel', 'Use o painel da Prova TCEL no canal autorizado.');
    }
  }
  // "any" = qualquer operador de qualquer ação (ex.: publicar o painel).
  const allowed = action === 'any'
    ? Array.from(new Set([...config.operatorIds.generate, ...config.operatorIds.results, ...config.operatorIds.promote]))
    : config.operatorIds[action] || [];
  if (!allowed.length) throw new ApiError(403, 'operators_not_configured', 'Nenhum operador autorizado para esta ação foi configurado no site.');
  if (!allowed.includes(actorDiscordId)) {
    await logThrottled('botghost_operator_denied', `o:${actorDiscordId}:${action}`, { actorDiscordId, action, route: req.path });
    throw new ApiError(403, 'operator_not_allowed', 'Você não está autorizado a usar esta função da Prova TCEL.');
  }
  return {
    guildId,
    actorDiscordId,
    actorDisplayName: userText(src.actorDisplayName || '', 80) || 'Operador',
    channelId: isSnowflake(channelId) ? channelId : null,
    config,
    action,
  };
}

module.exports = { createKeyAuth, resolveActor, safeEqual, MIN_KEY_LENGTH };
