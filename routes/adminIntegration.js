const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const Promotion = require('../models/Promotion');
const IntegrationNotification = require('../models/IntegrationNotification');
const env = require('../config/env');
const configStore = require('../botghost/configStore');
const notifications = require('../botghost/notifications');
const templates = require('../botghost/templates/store');
const { webhookConfigProblem } = require('../botghost/webhookClient');
const { MIN_KEY_LENGTH } = require('../botghost/auth');
const { resumePromotion, releasePromotion, acceptExternalState } = require('../botghost/promotionsService');
const { PLACEHOLDERS, PING_TARGET_LABELS } = require('../botghost/templates/catalog');
const { LIMITS } = require('../botghost/templates/render');
const { logSecurityEvent } = require('../lib/securityLog');
const { createSafeRouter } = require('../lib/safeRouter');

// Aba "Integração BotGhost" e editor "Mensagens do Bot". Montado dentro de
// routes/admin.js DEPOIS de requireAdmin + limite de taxa e sob a checagem
// de origem (CSRF) de server.js. Credenciais ficam só no ambiente: aqui só
// dizemos se estão definidas, nunca o valor.
const router = createSafeRouter();

function actor(req) {
  return `admin:${req.session.admin.username}`;
}

function kick() {
  require('../botghost').kickDispatcher();
}

function validId(id) {
  return mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(String(id));
}

router.get('/status', async (req, res) => {
  const b = env.botghost;
  const [config, counts] = await Promise.all([
    configStore.getConfig({ fresh: true }),
    IntegrationNotification.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({
    success: true,
    env: {
      enabled: b.enabled,
      siteApiKeyDefined: Boolean(b.siteApiKey),
      siteApiKeyStrong: Boolean(b.siteApiKey && b.siteApiKey.length >= MIN_KEY_LENGTH),
      allowedGuildId: b.allowedGuildId,
      notificationsEnabled: b.notificationsEnabled,
      webhookUrlDefined: Boolean(b.webhookUrl),
      webhookApiKeyDefined: Boolean(b.webhookApiKey),
      webhookProblem: b.notificationsEnabled ? webhookConfigProblem({ webhookUrl: b.webhookUrl, webhookApiKey: b.webhookApiKey }) : null,
      apiBaseUrl: `${env.publicBaseUrl}/api/integrations/botghost`,
      publicBaseUrlIsHttps: env.publicBaseUrl.startsWith('https://'),
    },
    status: config.status,
    panelMessage: config.panelMessage,
    notifications: Object.fromEntries(counts.map((c) => [c._id, c.n])),
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
  const { update, errors } = configStore.validateConfig(req.body || {});
  if (update.defaultExamId) {
    const exam = await Exam.findById(update.defaultExamId).select('_id').lean();
    if (!exam) errors.push('A prova padrão escolhida não existe.');
  }
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(' '), errors });
  const saved = await configStore.saveConfig(update, actor(req));
  // Avisos que falharam só por falta de canal configurado voltam para a fila.
  const requeued = await IntegrationNotification.updateMany(
    { status: { $in: ['failed', 'pending'] }, lastError: /não configurado/ },
    { $set: { status: 'pending', dispatchAttempts: 0, nextDispatchAt: new Date() } },
  );
  kick();
  await logSecurityEvent('integration_config_updated', { meta: { by: actor(req), config: { ...saved, status: undefined }, requeued: requeued.modifiedCount || 0 }, ip: req.ip });
  res.json({ success: true, config: saved });
});

// ---------------- Fila de avisos ----------------

router.get('/notifications', async (req, res) => {
  const filter = {};
  const { status, kind } = req.query;
  if (status && typeof status === 'string') filter.status = status;
  if (kind && typeof kind === 'string') filter.kind = kind;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const size = 30;
  const [total, items] = await Promise.all([
    IntegrationNotification.countDocuments(filter),
    IntegrationNotification.find(filter)
      .select('kind key status attemptId draftId templateKey chunkIndex dispatchAttempts maxDispatchAttempts nextDispatchAt message lastError lastErrorAt history createdAt updatedAt payload.userIds')
      .sort({ updatedAt: -1 }).skip(page * size).limit(size).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / size)), items });
});

router.post('/notifications/:id/retry', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  await notifications.adminRetry(req.params.id, actor(req));
  kick();
  res.json({ success: true });
});

router.post('/notifications/:id/resolve-ambiguous', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const { mode, messageId, channelId } = req.body || {};
  await notifications.adminResolveAmbiguous(req.params.id, { mode, messageId, channelId }, actor(req));
  kick();
  res.json({ success: true });
});

router.post('/panel/update', async (req, res) => {
  const n = await notifications.createPanelUpdate(actor(req));
  kick();
  res.json({ success: true, notificationId: String(n._id) });
});

// ---------------- Promoções ----------------

router.get('/promotions', async (req, res) => {
  const filter = {};
  if (req.query.status && typeof req.query.status === 'string') filter.status = req.query.status;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const size = 30;
  const [total, items] = await Promise.all([
    Promotion.countDocuments(filter),
    Promotion.find(filter).select('-evidence').sort({ updatedAt: -1 }).skip(page * size).limit(size).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / size)), items: items.map((p) => ({ ...p, active: Boolean(p.lockKey) })) });
});

router.post('/promotions/:id/resume', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const out = await resumePromotion(req.params.id, actor(req));
  if (out.kind === 'locked') return res.status(409).json({ success: false, message: 'Esta pessoa já tem outra promoção ativa.' });
  if (out.kind === 'nothing') return res.status(409).json({ success: false, message: 'Só promoções parciais ou com falha podem ser retomadas.' });
  res.json({ success: true, message: 'Retomada agendada: o operador continua pelo botão "Continuar promoção" no Discord.' });
});

router.post('/promotions/:id/release', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  await releasePromotion(req.params.id, { actor: actor(req), reason: (req.body || {}).reason });
  res.json({ success: true });
});

router.post('/promotions/:id/accept-external-state', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  await acceptExternalState(req.params.id, actor(req));
  res.json({ success: true, message: 'Liberado para aplicar só o que falta (sem anúncio). O operador continua pelo Discord.' });
});

// ---------------- Mensagens do Bot (editor) ----------------

router.get('/templates', async (req, res) => {
  res.json({
    success: true,
    templates: await templates.listTemplates(),
    placeholders: Object.entries(PLACEHOLDERS).map(([key, p]) => ({ key, help: p.help, sample: p.sensitive ? '(link fictício)' : p.sample, sensitive: Boolean(p.sensitive) })),
    pingTargets: PING_TARGET_LABELS,
    limits: LIMITS,
  });
});

function templateKey(req, res) {
  const key = String(req.params.key || '');
  if (!/^[a-z_]{2,40}$/.test(key)) {
    res.status(400).json({ success: false, message: 'Modelo inválido.' });
    return null;
  }
  return key;
}

// Erros de validação voltam por campo (errors: [{ path, message }]).
async function withFieldErrors(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status && err.errors) return res.status(err.status).json({ success: false, message: err.message, errors: err.errors });
    throw err;
  }
}

router.get('/templates/:key', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  res.json({ success: true, template: await templates.getEditorState(key) });
});

router.post('/templates/:key/preview', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  res.json({ success: true, ...templates.previewSpec(key, (req.body || {}).spec || {}) });
});

router.put('/templates/:key/draft', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  const out = await templates.saveDraft(key, (req.body || {}).spec || {}, actor(req));
  res.json({ success: true, ...out });
});

router.post('/templates/:key/publish', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  await withFieldErrors(res, async () => {
    const out = await templates.publish(key, (req.body || {}).spec || {}, actor(req));
    res.json({ success: true, ...out });
  });
});

router.post('/templates/:key/restore-default', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  const out = await templates.restoreDefault(key, actor(req));
  res.json({ success: true, ...out });
});

// Teste: ação explícita do admin, publicado no canal de TESTE com dados
// fictícios e sem pings. Usa o modelo PUBLICADO (publique antes de testar).
router.post('/templates/:key/test', async (req, res) => {
  const key = templateKey(req, res);
  if (!key) return;
  await templates.getEditorState(key);
  if (!env.botghost.enabled || !env.botghost.notificationsEnabled) {
    return res.status(409).json({ success: false, message: 'Avisos pelo webhook estão desligados (BOTGHOST_NOTIFICATIONS_ENABLED). O teste não pode ser enviado.' });
  }
  const n = await notifications.createTemplateTest(key, actor(req));
  kick();
  res.json({ success: true, notificationId: String(n._id), message: 'Teste na fila. Confira o canal de teste e o status na fila de avisos.' });
});

module.exports = router;
