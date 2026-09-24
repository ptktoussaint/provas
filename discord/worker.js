const ExamAttempt = require('../models/ExamAttempt');
const Promotion = require('../models/Promotion');
const DiscordTask = require('../models/DiscordTask');
const outbox = require('../lib/outbox');
const { PROCESSORS, onTaskFailed, enqueueAnnouncementFor } = require('./processors');
const { isPermanentError } = require('./errors');

const DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Processa a fila do Discord UMA tarefa por vez (uma única instância ativa
// do site). Só trabalha com o bot conectado; se o Discord cair, as tarefas
// esperam no banco e são retomadas quando ele voltar (ou após reinício).
class DiscordWorker {
  constructor({ ctx, intervalMs = 5000, reconcileMs = 60000, batch = 20, log = console }) {
    this.ctx = ctx;
    this.intervalMs = intervalMs;
    this.reconcileMs = reconcileMs;
    this.batch = batch;
    this.log = log;
    this.timer = null;
    this.reconcileTimer = null;
    this.running = null;
    this.stopped = true;
  }

  async start() {
    this.stopped = false;
    const released = await outbox.releaseStaleLocks().catch(() => 0);
    if (released) this.log.log(`[discord-worker] ${released} tarefa(s) interrompida(s) por reinício voltaram para a fila`);
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.reconcileTimer = setInterval(() => { this.reconcile().catch((err) => this.log.error('[discord-worker] reconciliação falhou:', outbox.safeErrorMessage(err))); }, this.reconcileMs);
    this.reconcile().catch(() => {});
    this.kick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 5000))]);
  }

  kick() {
    if (this.stopped || this.running) return this.running;
    this.running = this.tick().finally(() => { this.running = null; });
    return this.running;
  }

  async tick() {
    if (!this.ctx.adapter.isReady()) return 0;
    let processed = 0;
    while (!this.stopped && processed < this.batch) {
      const task = await outbox.claimNext();
      if (!task) break;
      await this.runTask(task);
      processed += 1;
    }
    return processed;
  }

  async runTask(task) {
    const processor = PROCESSORS[task.kind];
    try {
      if (!processor) throw Object.assign(new Error(`Tipo de tarefa desconhecido: ${task.kind}`), { permanent: true });
      const out = (await processor(task, this.ctx)) || {};
      if (out.superseded) await outbox.markSuperseded(task, out.note || null);
      else await outbox.markDone(task, out.note || null);
    } catch (err) {
      const permanent = isPermanentError(err);
      const exhausted = await outbox.markFailed(task, err, { permanent });
      this.log.error(`[discord-worker] tarefa ${task.kind} falhou (tentativa ${task.attempts}${exhausted ? ', desistindo' : ', vai repetir'}):`, outbox.safeErrorMessage(err));
      if (exhausted) await onTaskFailed(task, err, this.ctx).catch((e) => this.log.error('[discord-worker] onTaskFailed:', outbox.safeErrorMessage(e)));
    }
  }

  // Rede de segurança da outbox: recria tarefas que deveriam existir e não
  // existem (ex.: o processo caiu entre salvar a nota e enfileirar o aviso).
  async reconcile() {
    let created = 0;
    const stale = await ExamAttempt.find({
      discordUserId: { $ne: null },
      $expr: { $lt: [{ $ifNull: ['$discordSync.syncedRevision', 0] }, { $ifNull: ['$revision', 0] }] },
    }).select('_id revision discordUserId').limit(200).lean();
    for (const a of stale) {
      const key = outbox.resultSyncKey(a._id, a.revision || 0);
      if (!(await DiscordTask.exists({ key }))) {
        if (await outbox.enqueueResultSync(a)) created += 1;
      }
    }

    // Anúncios reservados cuja tarefa não chegou a ser gravada.
    const orphanKeys = await Promotion.distinct('announceTaskKey', { status: 'completed', announced: false, announceTaskKey: { $ne: null } });
    for (const key of orphanKeys) {
      if (!(await DiscordTask.exists({ key }))) {
        const promo = await Promotion.findOne({ announceTaskKey: key }).select('draftId');
        await Promotion.updateMany({ announceTaskKey: key, announced: false }, { $set: { announceTaskKey: null } });
        if (promo && await enqueueAnnouncementFor(promo.draftId, this.ctx)) created += 1;
      }
    }

    await DiscordTask.deleteMany({ status: { $in: ['done', 'superseded'] }, completedAt: { $lt: new Date(Date.now() - DONE_RETENTION_MS) } });
    if (created) {
      this.log.log(`[discord-worker] reconciliação recriou ${created} tarefa(s)`);
      this.kick();
    }
    return created;
  }
}

module.exports = { DiscordWorker };
