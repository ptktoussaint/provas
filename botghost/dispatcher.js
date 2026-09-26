const IntegrationNotification = require('../models/IntegrationNotification');
const ExamAttempt = require('../models/ExamAttempt');
const notifications = require('./notifications');
const configStore = require('./configStore');
const { triggerWebhook } = require('./webhookClient');

// Despacha as notificações pendentes para o webhook do BotGhost. Roda no
// próprio processo do site e SÓ enquanto ele está acordado (Render
// gratuito): nada de worker pago nem "ping" para mantê-lo ligado. Ao subir,
// retoma o que ficou pendente. Uma notificação por vez, com espera entre
// disparos, para respeitar limites do BotGhost.
class NotificationDispatcher {
  constructor({ getEnv, intervalMs = 10000, reconcileMs = 5 * 60 * 1000, gapMs = 1500, perTick = 5, fetchImpl, log = console }) {
    this.getEnv = getEnv;
    this.intervalMs = intervalMs;
    this.reconcileMs = reconcileMs;
    this.gapMs = gapMs;
    this.perTick = perTick;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.running = null;
    this.timer = null;
    this.reconcileTimer = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.reconcileTimer = setInterval(() => { this.reconcile().catch((e) => this.log.error('[botghost] reconciliação falhou:', notifications.safeError(e))); }, this.reconcileMs);
    this.reconcile().catch(() => {});
    this.kick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.reconcileTimer);
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 5000))]);
  }

  kick() {
    if (this.stopped || this.running) return this.running;
    this.running = this.tick().catch((e) => this.log.error('[botghost] despacho falhou:', notifications.safeError(e))).finally(() => { this.running = null; });
    return this.running;
  }

  async tick() {
    await notifications.expireLeases();
    const env = this.getEnv();
    if (!env.enabled || !env.notificationsEnabled) return 0;
    let sent = 0;
    while (!this.stopped && sent < this.perTick) {
      const now = new Date();
      const n = await IntegrationNotification.findOneAndUpdate(
        { status: 'pending', nextDispatchAt: { $lte: now } },
        { $set: { status: 'dispatched', dispatchedAt: now }, $inc: { dispatchAttempts: 1 } },
        { sort: { nextDispatchAt: 1 }, new: true },
      );
      if (!n) break;
      const res = await triggerWebhook({ webhookUrl: env.webhookUrl, webhookApiKey: env.webhookApiKey, notificationId: n._id, kind: n.kind, fetchImpl: this.fetchImpl });
      await this.recordOutcome(n, res);
      sent += 1;
      if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
    }
    return sent;
  }

  async recordOutcome(n, res) {
    const history = (event, detail) => ({ $push: { history: { $each: [{ at: new Date(), event, detail }], $slice: -30 } } });
    if (res.ok) {
      await IntegrationNotification.updateOne({ _id: n._id }, history('webhook_ok', String(res.status)));
      await configStore.recordStatus({ lastWebhookOkAt: new Date() });
      return;
    }
    const exhausted = res.permanent || n.dispatchAttempts >= (n.maxDispatchAttempts || 6);
    const wait = res.retryAfterMs || notifications.backoffMs(n.dispatchAttempts);
    // Condicional: se o evento já reservou (chegou antes da resposta), não mexe.
    await IntegrationNotification.updateOne({ _id: n._id, status: 'dispatched' }, {
      $set: exhausted
        ? { status: 'failed', lastError: res.error, lastErrorAt: new Date() }
        : { status: 'pending', nextDispatchAt: new Date(Date.now() + wait), lastError: res.error, lastErrorAt: new Date() },
      ...history(exhausted ? 'webhook_failed' : 'webhook_retry', res.error),
    });
    await configStore.recordStatus({ lastWebhookError: res.error, lastWebhookErrorAt: new Date() }, { force: true });
    this.log.warn(`[botghost] webhook não aceito (${res.status || 'rede'}): ${res.error}`);
  }

  // Rede de segurança: resultado finalizado que deveria ter aviso e não tem
  // (ex.: o processo caiu entre salvar a nota e criar o aviso).
  async reconcile() {
    const attempts = await ExamAttempt.find({
      discordUserId: { $ne: null },
      'discordSync.wantsMessage': true,
      deletedAt: null,
      status: { $in: ['finished', 'finished_timeout'] },
    }).select('_id').sort({ finishedAt: -1 }).limit(300).lean();
    const existing = new Set((await IntegrationNotification.find({ attemptId: { $in: attempts.map((a) => a._id) }, kind: 'result' }).select('attemptId').lean()).map((n) => String(n.attemptId)));
    let created = 0;
    for (const a of attempts) {
      if (existing.has(String(a._id))) continue;
      const full = await ExamAttempt.findById(a._id).select('-snapshot');
      if (await notifications.syncResultNotification(full)) created += 1;
    }
    created += await this.reconcileDafpRoles();
    if (created) this.kick();
    return created;
  }

  // DAFP: prova iniciada sem o aviso de remoção da Role base, ou resultado
  // excluído que ainda não devolveu a Role base (processo caiu no meio).
  async reconcileDafpRoles() {
    let created = 0;
    const started = await ExamAttempt.find({ examGroup: 'DAFP', status: 'in_progress', deletedAt: null, dafpBaseRoleRemovedId: { $ne: null } })
      .select('_id discordUserId dafpBaseRoleRemovedId').limit(300).lean();
    for (const a of started) {
      if (await IntegrationNotification.exists({ key: notifications.startKey(a._id) })) continue;
      if (await notifications.createDafpStartNotification(a)) created += 1;
    }
    const removed = await ExamAttempt.find({ examGroup: 'DAFP', deletedAt: { $ne: null }, dafpBaseRoleRemovedId: { $ne: null } })
      .select('_id').sort({ deletedAt: -1 }).limit(300).lean();
    for (const a of removed) {
      if (await IntegrationNotification.exists({ key: `result:${a._id}` })) continue;
      const full = await ExamAttempt.findById(a._id).select('-snapshot');
      if (await notifications.syncResultNotification(full)) created += 1;
    }
    return created;
  }
}

module.exports = { NotificationDispatcher };
