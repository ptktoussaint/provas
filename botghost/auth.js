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
// actorDiscordId que o BotGhost tira da interação real ({user_id}).
// - TCEL: o site confere o actorDiscordId na lista de IDs autorizados por
//   ação (configurada no admin).
// - DAFP: o acesso é por ROLE (dafp.professorRoleId). O site não fala com o
//   Discord (não tem token de bot), então quem atesta os cargos de quem
//   executou é o próprio BotGhost autenticado, em actorRoleIds — a mesma
//   confiança já dada ao actorDiscordId. Qual Role é exigida é decidido SÓ
//   no site (nunca vem no pedido).

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

const MAX_ROLE_TEXT = 8000;
const MAX_ROLES = 300;
const SNOWFLAKE_RUN = /(?<!\d)\d{17,20}(?!\d)/g;

// Cargos de quem executou, como o BotGhost entrega: lista de IDs ou de
// menções (<@&ID>), separados por vírgula/espaço, ou uma lista JSON de
// textos. Número no JSON perde precisão → recusado. null = campo ausente.
function parseActorRoleIds(raw) {
  if (raw == null) return null;
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = new Set();
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw new ApiError(400, 'invalid_field', 'actorRoleIds precisa ser texto (IDs ou menções dos cargos), nunca número.', { field: 'actorRoleIds' });
    }
    if (part.length > MAX_ROLE_TEXT) throw new ApiError(400, 'invalid_field', 'actorRoleIds grande demais.', { field: 'actorRoleIds' });
    for (const id of part.match(SNOWFLAKE_RUN) || []) out.add(id);
  }
  if (out.size > MAX_ROLES) throw new ApiError(400, 'invalid_field', 'actorRoleIds com cargos demais.', { field: 'actorRoleIds' });
  return [...out];
}

// DAFP: o operador precisa ter a Role de Professor DAFP configurada no site.
async function checkDafpProfessor(config, src, actorDiscordId, req) {
  const roleId = config.dafp.professorRoleId;
  if (!roleId) throw new ApiError(403, 'operators_not_configured', 'A Role de Professor DAFP não foi configurada no site (aba Integração BotGhost → Provas DAFP).');
  const roles = parseActorRoleIds(src.actorRoleIds);
  if (roles == null) {
    throw new ApiError(400, 'invalid_field', 'actorRoleIds obrigatório no /provas-dafp: envie os cargos de quem executou o comando (IDs ou menções).', { field: 'actorRoleIds' });
  }
  if (!roles.includes(roleId)) {
    await logThrottled('botghost_operator_denied', `o:${actorDiscordId}:dafp`, { actorDiscordId, action: 'dafp', rolesReceived: roles.length, route: req.path });
    throw new ApiError(403, 'operator_not_allowed', 'Você não está autorizado a gerar provas DAFP: é preciso ter a Role de Professor DAFP.', { rolesReceived: String(roles.length) });
  }
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
  // DAFP tem canal próprio (opcional) — o canal do painel TCEL não vale
  // para o /provas-dafp, e vice-versa.
  const isDafp = action === 'dafp';
  const requiredChannel = isDafp ? config.dafp.commandChannelId : config.channels.panel;
  if (requiredChannel) {
    if (!isSnowflake(channelId)) throw new ApiError(400, 'invalid_field', 'channelId obrigatório (use {channel_id}).', { field: 'channelId' });
    if (channelId !== requiredChannel) {
      await logThrottled('botghost_channel_denied', `c:${actorDiscordId}:${channelId}`, { actorDiscordId, channelId, route: req.path });
      throw new ApiError(403, 'wrong_channel', isDafp ? 'Use o /provas-dafp no canal autorizado.' : 'Use o painel da Prova TCEL no canal autorizado.');
    }
  }
  if (isDafp) {
    await checkDafpProfessor(config, src, actorDiscordId, req);
    return {
      guildId,
      actorDiscordId,
      actorDisplayName: userText(src.actorDisplayName || '', 80) || 'Operador',
      channelId: isSnowflake(channelId) ? channelId : null,
      config,
      action,
    };
  }
  // "any" = qualquer operador de qualquer ação TCEL (ex.: publicar o painel).
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

module.exports = { createKeyAuth, resolveActor, parseActorRoleIds, safeEqual, MIN_KEY_LENGTH };
