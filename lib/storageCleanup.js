const ExamAttempt = require('../models/ExamAttempt');
const Room = require('../models/Room');
const ExamEvent = require('../models/ExamEvent');
const SecurityLog = require('../models/SecurityLog');
const IntegrationNotification = require('../models/IntegrationNotification');
const Promotion = require('../models/Promotion');
const PromotionDraft = require('../models/PromotionDraft');
const StorageCleanup = require('../models/StorageCleanup');
const HistoryCounter = require('../models/HistoryCounter');
const { mongoose } = require('../config/db');
const liveState = require('./liveState');
const { logSecurityEvent } = require('./securityLog');

// "Limpar armazenamento" (Segurança & auditoria, só administrador principal).
//
// LISTA EXPLÍCITA do que pode ser apagado — nada fora dela é tocado (sem
// dropDatabase, sem drop de coleção, sem limpar "todas as coleções", sem
// nome aproximado). Só o banco deste site (a conexão do Mongoose); o quadro
// de consumo mede o cluster inteiro, a limpeza NÃO.
//
//  categoria      coleção                    data usada (precisa ser < corte)
//  attempts       examattempts               finishedAt (data de conclusão)
//  notifications  integrationnotifications   (vai junto com a tentativa apagada;
//                                             só result/dafp_started/dafp_base_restore
//                                             já concluídos: delivered/failed/cancelled)
//  rooms          rooms                      endedAt (encerramento); salas antigas
//                                             sem endedAt: updatedAt (sempre ≥ encerramento);
//                                             abandonadas (nunca iniciadas): updatedAt
//  examEvents     examevents                 at (data do evento)
//  securityLogs   securitylogs               at (data do evento)
//
// NUNCA apagados: exams, questions, settings, users, sessions,
// integrationconfigs, messagetemplates, integrationrequests (TTL próprio),
// promotions, promotiondrafts, storagecleanups, historycounters e qualquer
// outra coleção/banco. Registros sem data confiável são preservados.

const DAY = 24 * 60 * 60 * 1000;
const ALLOWED_DAYS = [90, 60, 30];
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const BATCH = 200;
const CHUNK = 1000;
const FINISHED = ['finished', 'finished_timeout'];
const TERMINAL_NOTIFICATION = ['delivered', 'failed', 'cancelled'];
const ATTEMPT_NOTIFICATION_KINDS = ['result', 'dafp_started', 'dafp_base_restore'];
const PROTECTED_LOG_TYPE = /^storage_cleanup/;
const FINISHED_COUNTER_KEY = 'finished_attempts_removed';

const CATEGORIES = [
  { key: 'attempts', label: 'Notas/resultados e tentativas (com as respostas)', collection: 'examattempts', dateField: 'finishedAt' },
  { key: 'notifications', label: 'Avisos do BotGhost já concluídos dessas tentativas', collection: 'integrationnotifications', dateField: 'tentativa apagada' },
  { key: 'rooms', label: 'Salas finalizadas, encerradas ou abandonadas', collection: 'rooms', dateField: 'endedAt (ou updatedAt)' },
  { key: 'examEvents', label: 'Eventos das provas (logs de fiscalização)', collection: 'examevents', dateField: 'at' },
  { key: 'securityLogs', label: 'Logs de segurança e auditoria', collection: 'securitylogs', dateField: 'at' },
];

const PRESERVED_LABELS = {
  attemptsInProgress: 'Provas em andamento iniciadas antes do corte',
  attemptsNoDate: 'Tentativas finalizadas sem data de conclusão (sem data confiável)',
  attemptsPromotion: 'Tentativas usadas por promoções (histórico de promoção / evita repetir promoção)',
  attemptsPendingNotification: 'Tentativas com aviso do BotGhost pendente, ambíguo ou aguardando edição',
  attemptsDafpRole: 'Provas DAFP com devolução da Role base ainda não confirmada',
  attemptsRoomKept: 'Tentativas cuja sala ainda é mantida (evita sala apontando para tentativa apagada)',
  roomsActive: 'Salas em andamento criadas antes do corte',
  roomsWithAttempts: 'Salas com tentativas que serão mantidas',
  roomsOnline: 'Salas abandonadas com alguém conectado agora',
  examEventsLinked: 'Eventos ligados a tentativas/salas mantidas',
  securityLogsCleanup: 'Registros de auditoria das próprias limpezas',
  attemptsChangedDuringRun: 'Tentativas que ganharam pendência durante a execução',
  roomsChangedDuringRun: 'Salas que ganharam atividade durante a execução',
};

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function chunks(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function distinctIn(model, field, path, ids, extra = {}) {
  const out = new Set();
  for (const part of chunks(ids)) {
    for (const v of await model.distinct(field, { [path]: { $in: part }, ...extra })) if (v) out.add(String(v));
  }
  return out;
}

// aggregate() não converte texto em ObjectId como find() faz.
function oid(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

function pause() {
  return new Promise((r) => setTimeout(r, 15));
}

// Proteções de uma tentativa finalizada: nada que ainda tenha função.
async function attemptProtections(attempts) {
  const ids = attempts.map((a) => a._id);
  const promotion = await distinctIn(Promotion, 'attemptId', 'attemptId', ids);
  const draft = await distinctIn(PromotionDraft, 'selections.attemptId', 'selections.attemptId', ids);
  const pending = await distinctIn(IntegrationNotification, 'attemptId', 'attemptId', ids, {
    $or: [{ status: { $nin: TERMINAL_NOTIFICATION } }, { needsUpdate: true }],
  });
  const reasons = new Map();
  for (const a of attempts) {
    const id = String(a._id);
    if (promotion.has(id) || draft.has(id)) reasons.set(id, 'attemptsPromotion');
    else if (pending.has(id)) reasons.set(id, 'attemptsPendingNotification');
    else if (a.dafpBaseRoleRemovedId && !(a.dafpBaseRole && a.dafpBaseRole.restoreConfirmedAt)) reasons.set(id, 'attemptsDafpRole');
  }
  return reasons;
}

function roomEligibleFilter(cutoff) {
  return {
    $or: [
      { status: { $in: ['finished', 'closed'] }, endedAt: { $type: 'date', $lt: cutoff } },
      { status: { $in: ['finished', 'closed'] }, endedAt: null, updatedAt: { $type: 'date', $lt: cutoff } },
      // Abandonada: link nunca usado (sem tentativa atual) e sem mudança desde o corte.
      { status: 'pending', currentAttemptId: null, updatedAt: { $type: 'date', $lt: cutoff } },
    ],
  };
}

// Plano completo para uma data de corte (somente leitura).
async function buildPlan(cutoff) {
  const preserved = Object.fromEntries(Object.keys(PRESERVED_LABELS).filter((k) => !k.endsWith('DuringRun')).map((k) => [k, 0]));

  const candidates = await ExamAttempt.find({ status: { $in: FINISHED }, finishedAt: { $type: 'date', $lt: cutoff } })
    .select('_id roomId dafpBaseRoleRemovedId dafpBaseRole.restoreConfirmedAt deletedAt').lean();
  const protections = await attemptProtections(candidates);
  for (const r of protections.values()) preserved[r] += 1;
  let attempts = new Map(candidates.filter((a) => !protections.has(String(a._id))).map((a) => [String(a._id), a]));

  const roomCandidates = await Room.find(roomEligibleFilter(cutoff)).select('_id status').lean();
  const roomIdsAll = roomCandidates.map((r) => r._id);
  const attemptsOfRooms = new Map();
  for (const part of chunks(roomIdsAll)) {
    for (const a of await ExamAttempt.find({ roomId: { $in: part } }).select('_id roomId').lean()) {
      const k = String(a.roomId);
      if (!attemptsOfRooms.has(k)) attemptsOfRooms.set(k, []);
      attemptsOfRooms.get(k).push(String(a._id));
    }
  }
  const attemptRoomIds = [...new Set([...attempts.values()].map((a) => String(a.roomId)))];
  const existingRooms = await distinctIn(Room, '_id', '_id', attemptRoomIds);

  let rooms = new Map(roomCandidates.map((r) => [String(r._id), r]));
  const online = new Set();
  for (const id of rooms.keys()) {
    const live = liveState.summary(id);
    if (live && (live.studentOnline || live.proctorCount > 0)) online.add(id);
  }
  // Sala e tentativas saem juntas: sala só se TODAS as suas tentativas saem;
  // tentativa só se a sala sai (ou já não existe).
  for (;;) {
    const nextRooms = new Map([...rooms].filter(([id]) => !online.has(id) && (attemptsOfRooms.get(id) || []).every((a) => attempts.has(a))));
    const nextAttempts = new Map([...attempts].filter(([, a]) => !existingRooms.has(String(a.roomId)) || nextRooms.has(String(a.roomId))));
    const stable = nextRooms.size === rooms.size && nextAttempts.size === attempts.size;
    rooms = nextRooms;
    attempts = nextAttempts;
    if (stable) break;
  }
  preserved.attemptsRoomKept = candidates.length - protections.size - attempts.size;
  preserved.roomsOnline = online.size;
  preserved.roomsWithAttempts = roomCandidates.length - rooms.size - online.size;
  preserved.attemptsInProgress = await ExamAttempt.countDocuments({ status: 'in_progress', startedAt: { $lt: cutoff } });
  preserved.attemptsNoDate = await ExamAttempt.countDocuments({ status: { $in: FINISHED }, finishedAt: { $not: { $type: 'date' } } });
  preserved.roomsActive = await Room.countDocuments({ status: 'active', createdAt: { $lt: cutoff } });

  const attemptIds = [...attempts.keys()];
  const roomIds = [...rooms.keys()];
  let notifications = 0;
  for (const part of chunks(attemptIds)) {
    notifications += await IntegrationNotification.countDocuments({ attemptId: { $in: part }, kind: { $in: ATTEMPT_NOTIFICATION_KINDS }, status: { $in: TERMINAL_NOTIFICATION } });
  }

  const eventFilter = await examEventFilter(cutoff, new Set(attemptIds), new Set(roomIds));
  const examEvents = await ExamEvent.countDocuments(eventFilter);
  preserved.examEventsLinked = (await ExamEvent.countDocuments({ at: { $lt: cutoff } })) - examEvents;

  const logFilter = securityLogFilter(cutoff);
  const securityLogs = await SecurityLog.countDocuments(logFilter);
  preserved.securityLogsCleanup = await SecurityLog.countDocuments({ at: { $lt: cutoff }, type: PROTECTED_LOG_TYPE });

  return {
    attemptIds,
    roomIds,
    eventFilter,
    logFilter,
    counts: { attempts: attemptIds.length, notifications, rooms: roomIds.length, examEvents, securityLogs },
    preserved,
  };
}

// Evento antigo só sai se tudo a que ele se liga também sai (ou já não
// existe): nunca deixa tentativa/sala mantida sem o próprio histórico.
async function examEventFilter(cutoff, deletingAttempts, deletingRooms) {
  const base = { at: { $type: 'date', $lt: cutoff } };
  const refAttempts = (await ExamEvent.distinct('attemptId', base)).filter(Boolean).map(String);
  const refRooms = (await ExamEvent.distinct('roomId', base)).filter(Boolean).map(String);
  const keptAttempts = [...await distinctIn(ExamAttempt, '_id', '_id', refAttempts)].filter((id) => !deletingAttempts.has(id));
  const keptRooms = [...await distinctIn(Room, '_id', '_id', refRooms)].filter((id) => !deletingRooms.has(id));
  return { ...base, attemptId: { $nin: keptAttempts.map(oid) }, roomId: { $nin: keptRooms.map(oid) } };
}

function securityLogFilter(cutoff) {
  return { at: { $type: 'date', $lt: cutoff }, type: { $not: PROTECTED_LOG_TYPE } };
}

// Estimativa (só dados, sem índices) — o Atlas pode não reduzir igual.
async function estimateBytes(plan) {
  async function sumIds(model, ids) {
    let total = 0;
    for (const part of chunks(ids)) {
      const [r] = await model.aggregate([{ $match: { _id: { $in: part.map(oid) } } }, { $group: { _id: null, s: { $sum: { $bsonSize: '$$ROOT' } } } }]);
      total += r ? r.s : 0;
    }
    return total;
  }
  async function sumFilter(model, filter) {
    const [r] = await model.aggregate([{ $match: filter }, { $group: { _id: null, s: { $sum: { $bsonSize: '$$ROOT' } } } }]);
    return r ? r.s : 0;
  }
  try {
    const attemptIdsObj = plan.attemptIds;
    let notif = 0;
    for (const part of chunks(attemptIdsObj)) {
      const ids = (await IntegrationNotification.find({ attemptId: { $in: part }, kind: { $in: ATTEMPT_NOTIFICATION_KINDS }, status: { $in: TERMINAL_NOTIFICATION } }).select('_id').lean()).map((n) => n._id);
      notif += await sumIds(IntegrationNotification, ids);
    }
    return (await sumIds(ExamAttempt, plan.attemptIds)) + notif + (await sumIds(Room, plan.roomIds))
      + (await sumFilter(ExamEvent, plan.eventFilter)) + (await sumFilter(SecurityLog, plan.logFilter));
  } catch (_) {
    return null;
  }
}

function describe(doc) {
  return {
    id: String(doc._id),
    status: doc.status,
    days: doc.days,
    cutoff: doc.cutoff,
    expiresAt: doc.expiresAt,
    createdByName: doc.createdByName,
    categories: CATEGORIES,
    preservedLabels: PRESERVED_LABELS,
    preview: doc.preview,
    progress: doc.progress,
    result: doc.result,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
  };
}

async function createPreview({ days, admin, now = new Date() }) {
  const d = Number(days);
  if (!ALLOWED_DAYS.includes(d)) throw badRequest('Período inválido: escolha 90, 60 ou 30 dias.');
  // Data de corte FIXADA aqui, no servidor, no momento da prévia.
  const cutoff = new Date(now.getTime() - d * DAY);
  const plan = await buildPlan(cutoff);
  const estimatedBytes = await estimateBytes(plan);
  // Prévias vencidas há mais de 1 dia (só as nossas, nunca execuções).
  await StorageCleanup.deleteMany({ status: 'preview', expiresAt: { $lt: new Date(now.getTime() - DAY) } });
  const doc = await StorageCleanup.create({
    status: 'preview',
    days: d,
    cutoff,
    createdBy: admin.id,
    createdByName: admin.username,
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
    preview: { counts: plan.counts, preserved: plan.preserved, estimatedBytes, generatedAt: now },
  });
  return describe(doc);
}

let runningInProcess = false;

async function startCleanup({ previewId, cutoff, admin, ip, now = new Date() }) {
  let preview = null;
  try { preview = await StorageCleanup.findById(previewId); } catch (_) { /* id inválido */ }
  if (!preview || preview.status !== 'preview') throw badRequest('Prévia não encontrada ou já usada. Gere uma nova prévia.', 409);
  if (preview.createdBy !== admin.id) throw badRequest('Esta prévia foi gerada por outro administrador. Gere uma nova prévia.', 403);
  if (preview.expiresAt.getTime() < now.getTime()) throw badRequest('A prévia venceu (validade de 10 minutos). Gere uma nova prévia.', 410);
  if (!cutoff || new Date(cutoff).getTime() !== preview.cutoff.getTime()) throw badRequest('A data de corte não confere com a prévia. Gere uma nova prévia.', 409);
  if (runningInProcess) throw badRequest('Já existe uma limpeza em execução. Aguarde terminar.', 409);

  let run;
  try {
    run = await StorageCleanup.findOneAndUpdate(
      { _id: preview._id, status: 'preview' },
      { $set: { status: 'running', lockKey: 'global', startedAt: now, progress: { phase: 'starting', deleted: {} } } },
      { new: true },
    );
  } catch (err) {
    if (err && err.code === 11000) throw badRequest('Já existe uma limpeza em execução. Aguarde terminar.', 409);
    throw err;
  }
  if (!run) throw badRequest('Prévia não encontrada ou já usada. Gere uma nova prévia.', 409);
  runningInProcess = true;
  const promise = execute(run, { admin, ip }).finally(() => { runningInProcess = false; });
  return { run: describe(run), promise };
}

async function setProgress(run, progress) {
  await StorageCleanup.updateOne({ _id: run._id }, { $set: { progress } });
}

// Execução em lotes. Elegibilidade REVALIDADA agora (com a mesma data de
// corte da prévia) e de novo a cada lote, logo antes de apagar: o que passou
// a ter atividade ou pendência desde a prévia é preservado.
async function execute(run, { admin, ip }) {
  const cutoff = run.cutoff;
  const deleted = { attempts: 0, notifications: 0, rooms: 0, examEvents: 0, securityLogs: 0 };
  const skipped = { attempts: 0, rooms: 0 };
  const failures = [];
  let preserved = {};
  const progress = (phase) => setProgress(run, { phase, deleted: { ...deleted } });

  try {
    const plan = await buildPlan(cutoff);
    preserved = plan.preserved;
    const deletingAttempts = new Set();

    // 1. Tentativas (+ avisos concluídos delas).
    await progress('attempts');
    try {
      for (const ids of chunks(plan.attemptIds, BATCH)) {
        const fresh = await ExamAttempt.find({ _id: { $in: ids }, status: { $in: FINISHED }, finishedAt: { $type: 'date', $lt: cutoff } })
          .select('_id roomId dafpBaseRoleRemovedId dafpBaseRole.restoreConfirmedAt deletedAt').lean();
        const prot = await attemptProtections(fresh);
        const ok = fresh.filter((a) => !prot.has(String(a._id)));
        skipped.attempts += ids.length - ok.length;
        if (!ok.length) continue;
        const okIds = ok.map((a) => a._id);
        const countable = ok.filter((a) => !a.deletedAt).length;
        const r = await ExamAttempt.deleteMany({ _id: { $in: okIds }, status: { $in: FINISHED }, finishedAt: { $lt: cutoff } });
        deleted.attempts += r.deletedCount || 0;
        // O total de "Provas finalizadas" do Dashboard não diminui.
        await HistoryCounter.add(FINISHED_COUNTER_KEY, Math.min(countable, r.deletedCount || 0));
        okIds.forEach((id) => deletingAttempts.add(String(id)));
        const n = await IntegrationNotification.deleteMany({ attemptId: { $in: okIds }, kind: { $in: ATTEMPT_NOTIFICATION_KINDS }, status: { $in: TERMINAL_NOTIFICATION } });
        deleted.notifications += n.deletedCount || 0;
        await progress('attempts');
        await pause();
      }
    } catch (err) { failures.push({ category: 'attempts', message: safeMessage(err) }); }

    // 2. Salas — só sem nenhuma tentativa restante.
    await progress('rooms');
    try {
      for (const ids of chunks(plan.roomIds, BATCH)) {
        const withAttempts = await distinctIn(ExamAttempt, 'roomId', 'roomId', ids);
        const ok = ids.filter((id) => !withAttempts.has(id) && !(liveState.summary(id) && (liveState.summary(id).studentOnline || liveState.summary(id).proctorCount > 0)));
        skipped.rooms += ids.length - ok.length;
        if (!ok.length) continue;
        const r = await Room.deleteMany({ _id: { $in: ok }, ...roomEligibleFilter(cutoff) });
        deleted.rooms += r.deletedCount || 0;
        ok.forEach((id) => liveState.removeRoom(id));
        await progress('rooms');
        await pause();
      }
    } catch (err) { failures.push({ category: 'rooms', message: safeMessage(err) }); }

    // 3. Eventos de prova (filtro recalculado depois das exclusões acima).
    await progress('examEvents');
    try {
      const filter = await examEventFilter(cutoff, new Set(), new Set());
      deleted.examEvents += await deleteByFilter(ExamEvent, filter, () => progress('examEvents'));
    } catch (err) { failures.push({ category: 'examEvents', message: safeMessage(err) }); }

    // 4. Logs de segurança/auditoria (exceto os das próprias limpezas).
    await progress('securityLogs');
    try {
      deleted.securityLogs += await deleteByFilter(SecurityLog, securityLogFilter(cutoff), () => progress('securityLogs'));
    } catch (err) { failures.push({ category: 'securityLogs', message: safeMessage(err) }); }
  } catch (err) {
    failures.push({ category: 'geral', message: safeMessage(err) });
  }

  preserved = { ...preserved, attemptsChangedDuringRun: skipped.attempts, roomsChangedDuringRun: skipped.rooms };
  const result = { deleted, preserved, failures, previewCounts: (run.preview && run.preview.counts) || null };
  const status = failures.length ? 'failed' : 'done';
  await StorageCleanup.updateOne({ _id: run._id }, { $set: { status, result, finishedAt: new Date(), progress: { phase: 'finished', deleted } }, $unset: { lockKey: 1 } });
  // Entrada nova de auditoria (tipo protegido: a limpeza nunca a apaga).
  await logSecurityEvent(failures.length ? 'storage_cleanup_failed' : 'storage_cleanup_executed', {
    meta: { runId: String(run._id), by: admin.username, days: run.days, cutoff: run.cutoff.toISOString(), deleted, failures: failures.length },
    ip,
  });
  require('./clusterStorage').invalidate();
  return result;
}

async function deleteByFilter(model, filter, onBatch) {
  let total = 0;
  for (;;) {
    const ids = (await model.find(filter).select('_id').limit(BATCH).lean()).map((d) => d._id);
    if (!ids.length) break;
    const r = await model.deleteMany({ _id: { $in: ids }, ...filter });
    total += r.deletedCount || 0;
    await onBatch();
    await pause();
    if (!r.deletedCount) break;
  }
  return total;
}

function safeMessage(err) {
  return String((err && err.message) || 'erro').slice(0, 200);
}

async function getRun(id) {
  let doc = null;
  try { doc = await StorageCleanup.findById(id).lean(); } catch (_) { /* id inválido */ }
  return doc ? describe(doc) : null;
}

async function currentRun() {
  const doc = await StorageCleanup.findOne({ status: 'running' }).lean();
  return doc ? describe(doc) : null;
}

async function history(limit = 10) {
  const docs = await StorageCleanup.find({ status: { $in: ['done', 'failed', 'interrupted'] } }).sort({ startedAt: -1 }).limit(limit).lean();
  return docs.map(describe);
}

// Reinício do site no meio de uma limpeza: marca como interrompida e solta
// a trava (o que já foi apagado está registrado no progresso).
async function recoverInterruptedRuns() {
  await StorageCleanup.updateMany({ status: 'running' }, { $set: { status: 'interrupted', finishedAt: new Date() }, $unset: { lockKey: 1 } });
}

module.exports = {
  ALLOWED_DAYS,
  CATEGORIES,
  PRESERVED_LABELS,
  FINISHED_COUNTER_KEY,
  PREVIEW_TTL_MS,
  buildPlan,
  createPreview,
  startCleanup,
  getRun,
  currentRun,
  history,
  recoverInterruptedRuns,
};
