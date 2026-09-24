const configStore = require('./configStore');
const { safeErrorMessage } = require('../lib/outbox');

// Ponto de entrada da integração com o Discord. Roda no mesmo processo do
// site (uma única instância), mas tudo aqui é isolado: se o Discord cair,
// estiver mal configurado ou DISCORD_ENABLED não for "true", o HTTP, o
// Socket.io e as provas seguem funcionando normalmente. O discord.js só é
// carregado quando a integração está ligada.
//
// Para virar um worker separado no futuro, basta um script que conecte no
// Mongo e chame startDiscord() — nada aqui depende do Express/Socket.io.

const state = {
  status: 'disabled', // disabled | misconfigured | connecting | ready | reconnecting | error | stopped
  since: new Date(),
  botTag: null,
  botId: null,
  guildFound: null,
  lastReadyAt: null,
  lastError: null,
  lastErrorAt: null,
};

let client = null;
let worker = null;
let adapterRef = null;
let guildIdRef = null;
let retryTimer = null;
let stopping = false;

function setStatus(status, extra = {}) {
  state.status = status;
  state.since = new Date();
  Object.assign(state, extra);
}

function recordError(message) {
  state.lastError = message;
  state.lastErrorAt = new Date();
  configStore.recordError(message).catch(() => {});
}

function getStatus() {
  return { ...state };
}

function missingEnv(discordEnv) {
  const missing = [];
  if (!discordEnv.botToken) missing.push('DISCORD_BOT_TOKEN');
  if (!discordEnv.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!discordEnv.guildId) missing.push('DISCORD_GUILD_ID');
  return missing;
}

async function startDiscord({ env, log = console }) {
  stopping = false;
  const discordEnv = env.discord;
  if (!discordEnv.enabled) {
    setStatus('disabled');
    log.log('[discord] integração desativada (DISCORD_ENABLED não é "true") — o site funciona normalmente sem ela.');
    return getStatus();
  }
  const missing = missingEnv(discordEnv);
  if (missing.length) {
    setStatus('misconfigured');
    recordError(`Variáveis de ambiente faltando: ${missing.join(', ')}`);
    log.warn(`[discord] integração ligada, mas faltam variáveis: ${missing.join(', ')} — bot não iniciado.`);
    return getStatus();
  }

  let discord;
  try {
    discord = require('discord.js');
  } catch (err) {
    setStatus('error');
    recordError(`Não foi possível carregar o discord.js: ${safeErrorMessage(err)}`);
    return getStatus();
  }

  const { Client, GatewayIntentBits, Events } = discord;
  const { createAdapter } = require('./adapter');
  const { createRouter } = require('./router');
  const { DiscordWorker } = require('./worker');
  const { createPanelHandler } = require('./handlers/panel');
  const { createGenerateHandler } = require('./handlers/generate');
  const { createResultsHandler } = require('./handlers/results');
  const { createPromoteHandler } = require('./handlers/promote');

  // Só a intent Guilds: nada de Message Content, Presence ou lista de
  // membros. Membros são consultados por ID via REST quando necessário.
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
    rest: { timeout: 15000 },
  });

  const adapter = createAdapter(client);
  adapterRef = adapter;
  guildIdRef = discordEnv.guildId;
  const ctx = {
    adapter,
    guildId: discordEnv.guildId,
    publicBaseUrl: env.publicBaseUrl,
    getConfig: (opts) => configStore.getConfig(opts),
    configStore,
    kickWorker: () => worker && worker.kick(),
  };
  worker = new DiscordWorker({ ctx, log });
  ctx.worker = worker;

  const router = createRouter({
    handlers: {
      panel: createPanelHandler(ctx),
      generate: createGenerateHandler(ctx),
      results: createResultsHandler(ctx),
      promote: createPromoteHandler(ctx),
    },
    getConfig: () => configStore.getConfig(),
    expectedGuildId: discordEnv.guildId,
    log,
  });

  client.on(Events.ClientReady, (c) => {
    const guildFound = c.guilds.cache.has(discordEnv.guildId);
    setStatus('ready', { botTag: c.user.tag, botId: c.user.id, lastReadyAt: new Date(), guildFound });
    log.log(`[discord] conectado como ${c.user.tag}${guildFound ? '' : ' — ATENÇÃO: o bot não está no servidor DISCORD_GUILD_ID'}`);
    if (!guildFound) recordError('O bot está conectado, mas não faz parte do servidor configurado em DISCORD_GUILD_ID. Convide-o com o link gerado por "npm run discord".');
    configStore.getConfig({ fresh: true }).catch(() => {});
    worker.kick();
  });
  client.on(Events.ShardDisconnect, (event) => {
    if (stopping) return;
    setStatus('reconnecting');
    log.warn(`[discord] gateway desconectado (código ${event && event.code}) — o discord.js vai tentar reconectar`);
  });
  client.on(Events.ShardReconnecting, () => { if (!stopping) setStatus('reconnecting'); });
  client.on(Events.ShardResume, () => { setStatus('ready'); worker.kick(); });
  client.on(Events.ShardError, (err) => { log.error('[discord] erro no gateway:', safeErrorMessage(err)); });
  client.on(Events.Error, (err) => { log.error('[discord] erro no cliente:', safeErrorMessage(err)); recordError(safeErrorMessage(err)); });
  client.on(Events.Warn, (msg) => log.warn('[discord] aviso:', safeErrorMessage(msg)));
  client.on(Events.GuildCreate, (guild) => { if (guild.id === discordEnv.guildId) state.guildFound = true; });
  client.on(Events.GuildDelete, (guild) => { if (guild.id === discordEnv.guildId) { state.guildFound = false; recordError('O bot foi removido do servidor configurado.'); } });
  client.on(Events.InteractionCreate, (interaction) => {
    router(interaction).catch((err) => log.error('[discord] interação:', safeErrorMessage(err)));
  });

  await worker.start();
  login(discordEnv.botToken, log, 0);
  return getStatus();
}

// Login com nova tentativa espaçada para falhas de rede. Token inválido não
// é repetido (exige ação humana). Depois do primeiro login, a reconexão do
// gateway é feita pelo próprio discord.js.
function login(token, log, attempt) {
  if (stopping || !client) return;
  setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
  client.login(token).catch((err) => {
    const message = safeErrorMessage(err);
    const invalidToken = (err && err.code === 'TokenInvalid') || (/token/i.test(message) && /invalid/i.test(message));
    const disallowedIntents = /disallowed intents/i.test(message);
    if (invalidToken || disallowedIntents) {
      setStatus('error');
      recordError(invalidToken ? 'Token do bot inválido — gere um novo no Developer Portal e atualize DISCORD_BOT_TOKEN.' : message);
      log.error(`[discord] login recusado: ${invalidToken ? 'token inválido' : message}`);
      return;
    }
    const delay = Math.min(10 * 60 * 1000, 15000 * 2 ** attempt);
    recordError(`Falha ao conectar no Discord (vai tentar de novo em ${Math.round(delay / 1000)}s): ${message}`);
    log.error(`[discord] falha ao conectar, nova tentativa em ${Math.round(delay / 1000)}s:`, message);
    retryTimer = setTimeout(() => login(token, log, attempt + 1), delay);
  });
}

async function stopDiscord() {
  stopping = true;
  clearTimeout(retryTimer);
  if (worker) await worker.stop().catch(() => {});
  if (client) await client.destroy().catch(() => {});
  worker = null;
  client = null;
  if (state.status !== 'disabled' && state.status !== 'misconfigured') setStatus('stopped');
}

function kickWorker() {
  if (worker) worker.kick();
}

// Usado pelo botão "Verificar no Discord" da aba Discord do admin.
async function guildSnapshot(options) {
  if (!client || !client.isReady() || !adapterRef) throw Object.assign(new Error('O bot não está conectado ao Discord agora.'), { status: 409 });
  return adapterRef.guildSnapshot(guildIdRef, options);
}

module.exports = { startDiscord, stopDiscord, getStatus, kickWorker, guildSnapshot };
