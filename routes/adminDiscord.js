const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const DiscordTask = require('../models/DiscordTask');
const Promotion = require('../models/Promotion');
const env = require('../config/env');
const discord = require('../discord');
const configStore = require('../discord/configStore');
const { validateDiscordConfig } = require('../discord/configValidation');
const { resumePromotion, releasePromotion } = require('../discord/promotionService');
const { retryTask } = require('../lib/outbox');
const { logSecurityEvent } = require('../lib/securityLog');
const { createSafeRouter } = require('../lib/safeRouter');

// Aba "Discord" do painel admin. Montado dentro de routes/admin.js DEPOIS
// de requireAdmin + limite de taxa, e sob a checagem de origem (CSRF) de
// server.js — mesmas proteções de qualquer outra rota do admin. O token do
// bot nunca sai daqui: só dizemos se ele está definido.
const router = createSafeRouter();

function actor(req) {
  return `admin:${req.session.admin.username}`;
}

router.get('/status', async (req, res) => {
  const [counts, config] = await Promise.all([
    DiscordTask.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    configStore.getConfig({ fresh: true }),
  ]);
  const taskCounts = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  res.json({
    success: true,
    env: {
      enabled: env.discord.enabled,
      hasToken: Boolean(env.discord.botToken),
      clientId: env.discord.clientId,
      guildId: env.discord.guildId,
      publicBaseUrl: env.publicBaseUrl,
      publicBaseUrlIsHttps: env.publicBaseUrl.startsWith('https://'),
      inviteUrl: env.discord.clientId && env.discord.guildId
        ? require('../discord/registerCommands').inviteUrl({ clientId: env.discord.clientId, guildId: env.discord.guildId })
        : null,
    },
    runtime: discord.getStatus(),
    tasks: taskCounts,
    lastConfigError: config.lastError,
    lastConfigErrorAt: config.lastErrorAt,
  });
});

router.get('/config', async (req, res) => {
  const [config, exams] = await Promise.all([
    configStore.getConfig({ fresh: true }),
    Exam.find().select('name active').sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ success: true, config, exams });
});

router.put('/config', async (req, res) => {
  const { update, errors } = validateDiscordConfig(req.body || {});
  if (update.defaultExamId) {
    const exam = await Exam.findById(update.defaultExamId).select('_id').lean();
    if (!exam) errors.push('A prova padrão escolhida não existe.');
  }
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(' '), errors });

  const saved = await configStore.saveConfig(update, actor(req));
  // Tarefas que falharam só por falta de configuração voltam para a fila.
  const retried = await DiscordTask.updateMany(
    { status: 'failed', lastError: /^CONFIG:/ },
    { $set: { status: 'pending', attempts: 0, nextRunAt: new Date() } },
  );
  discord.kickWorker();
  await logSecurityEvent('discord_config_updated', { meta: { by: actor(req), config: saved, requeued: retried.modifiedCount || 0 }, ip: req.ip });
  res.json({ success: true, config: saved });
});

// Confere no Discord, com o bot conectado, se canais/cargos existem e se o
// bot tem as permissões e a posição de cargo necessárias.
router.post('/verify', async (req, res) => {
  const config = await configStore.getConfig({ fresh: true });
  const promo = config.promotion;
  const roleIds = Array.from(new Set([
    ...promo.addRoleIds, ...promo.removeRoleIds, promo.announceRoleId,
    ...config.operatorRoles.generate, ...config.operatorRoles.results, ...config.operatorRoles.promote,
  ].filter(Boolean)));
  const snapshot = await discord.guildSnapshot({
    roleIds,
    announceChannelId: promo.announceChannelId,
    extraChannelIds: [config.panelChannelId, config.resultsChannelId].filter(Boolean),
  });
  const { checkGlobal } = require('../discord/preflight');
  const promotionCheck = checkGlobal({ config, guild: snapshot });
  res.json({ success: true, snapshot, promotionCheck });
});

// Mesmo registro do `npm run discord`, para quem não usa terminal: o token
// é lido do ambiente do servidor e nunca volta para o navegador.
router.post('/register-commands', async (req, res) => {
  const { registerGuildCommands, explainRegisterError } = require('../discord/registerCommands');
  const { botToken: token, clientId, guildId } = env.discord;
  if (!token || !clientId || !guildId) {
    return res.status(409).json({ success: false, message: 'Defina DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID e DISCORD_GUILD_ID nas variáveis de ambiente do Render primeiro.' });
  }
  try {
    const saved = await registerGuildCommands({ token, clientId, guildId });
    await logSecurityEvent('discord_commands_registered', { meta: { by: actor(req), commands: saved.map((c) => c.name) }, ip: req.ip });
    res.json({ success: true, commands: saved });
  } catch (err) {
    const hint = explainRegisterError(err);
    res.status(502).json({ success: false, message: hint || 'O Discord recusou o registro do comando. Confira as variáveis e se o bot está no servidor.' });
  }
});

router.get('/tasks', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  const tasks = await DiscordTask.find(filter).sort({ updatedAt: -1 }).limit(100)
    .select('key kind status attempts maxAttempts nextRunAt lastError lastErrorAt completedAt note updatedAt createdAt attemptId promotionId draftId').lean();
  res.json({ success: true, tasks });
});

router.post('/tasks/:taskId/retry', async (req, res) => {
  const { taskId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(taskId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const task = await retryTask(taskId);
  if (!task) return res.status(409).json({ success: false, message: 'Só tarefas com falha podem ser reprocessadas.' });
  discord.kickWorker();
  await logSecurityEvent('discord_task_retried', { meta: { taskId, kind: task.kind, by: actor(req) }, ip: req.ip });
  res.json({ success: true });
});

router.get('/promotions', async (req, res) => {
  const promotions = await Promotion.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, promotions });
});

router.post('/promotions/:promotionId/resume', async (req, res) => {
  const { promotionId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(promotionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const out = await resumePromotion(promotionId, actor(req));
  if (out.kind === 'nothing') return res.status(409).json({ success: false, message: 'Esta promoção não tem etapas para retomar.' });
  if (out.kind === 'locked') return res.status(409).json({ success: false, message: 'Este usuário já tem outra promoção ativa por esta integração.' });
  discord.kickWorker();
  res.json({ success: true });
});

router.post('/promotions/:promotionId/release', async (req, res) => {
  const { promotionId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(promotionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  await releasePromotion(promotionId, { actor: actor(req), reason: (req.body || {}).reason });
  res.json({ success: true });
});

module.exports = router;
