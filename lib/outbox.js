const DiscordTask = require('../models/DiscordTask');

const LOCK_MS = 2 * 60 * 1000;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

function backoffMs(attempts) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

function isDuplicateKeyError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

// Nunca lança: enfileirar é sempre um efeito colateral "melhor esforço" de
// algo mais importante (ex.: finalizar a prova). Se falhar, a reconciliação
// periódica (discord/worker.js) recria a tarefa que faltou.
async function enqueue({ key, kind, attemptId = null, revision = null, promotionId = null, draftId = null, payload = null, runAt = null }) {
  try {
    await DiscordTask.updateOne(
      { key },
      {
        $setOnInsert: {
          key, kind, attemptId, revision, promotionId, draftId, payload,
          status: 'pending', attempts: 0, nextRunAt: runAt || new Date(),
        },
      },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return true;
    console.error('[outbox] falha ao enfileirar', kind, err.message);
    return false;
  }
}

function resultSyncKey(attemptId, revision) {
  return `result:${attemptId}:r${revision}`;
}

async function enqueueResultSync(attempt) {
  if (!attempt || !attempt.discordUserId) return false;
  const revision = attempt.revision || 0;
  return enqueue({ key: resultSyncKey(attempt._id, revision), kind: 'result_sync', attemptId: attempt._id, revision });
}

// Pega a próxima tarefa vencida de forma atômica. Tarefas "processing" com
// trava vencida são de um processo que morreu no meio (reinício) e voltam a
// ser elegíveis.
async function claimNext(now = new Date()) {
  return DiscordTask.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextRunAt: { $lte: now } },
        { status: 'processing', lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextRunAt: 1 }, new: true },
  );
}

async function markDone(task, note = null) {
  await DiscordTask.updateOne(
    { _id: task._id },
    { $set: { status: 'done', completedAt: new Date(), lockedUntil: null, note } },
  );
}

async function markSuperseded(task, note) {
  await DiscordTask.updateOne({ _id: task._id }, { $set: { status: 'superseded', completedAt: new Date(), lockedUntil: null, note } });
}

// Erro permanente (ex.: sem permissão) vira "failed" na hora; transitório
// volta para "pending" com espera crescente até esgotar as tentativas.
async function markFailed(task, err, { permanent = false } = {}) {
  const message = safeErrorMessage(err);
  const exhausted = permanent || task.attempts >= (task.maxAttempts || 8);
  const set = { lastError: message, lastErrorAt: new Date(), lockedUntil: null };
  if (exhausted) {
    set.status = 'failed';
  } else {
    set.status = 'pending';
    set.nextRunAt = new Date(Date.now() + backoffMs(task.attempts));
  }
  await DiscordTask.updateOne({ _id: task._id }, { $set: set });
  return exhausted;
}

async function saveProgress(task, progress) {
  task.progress = progress;
  await DiscordTask.updateOne({ _id: task._id }, { $set: { progress } });
}

// Processo único (uma instância ativa): ao subir, tudo que estava
// "processing" pertencia ao processo anterior, que já morreu.
async function releaseStaleLocks() {
  const res = await DiscordTask.updateMany({ status: 'processing' }, { $set: { status: 'pending', lockedUntil: null, nextRunAt: new Date() } });
  return res.modifiedCount || 0;
}

async function retryTask(taskId) {
  return DiscordTask.findOneAndUpdate(
    { _id: taskId, status: 'failed' },
    { $set: { status: 'pending', attempts: 0, nextRunAt: new Date(), lastError: null } },
    { new: true },
  );
}

// Mensagens de erro vão para o banco e para a tela do admin: nunca podem
// carregar token do bot, token de interação ou links de prova.
function safeErrorMessage(err) {
  let msg = String((err && (err.message || err)) || 'erro desconhecido');
  msg = msg.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, '[token]');
  msg = msg.replace(/\/(aluno|professor)\/[A-Za-z0-9_-]+/g, '/$1/[link]');
  msg = msg.replace(/webhooks\/\d+\/[A-Za-z0-9_-]+/g, 'webhooks/[token]');
  if (err && err.code && !msg.includes(String(err.code))) msg = `${msg} (código ${err.code})`;
  return msg.slice(0, 500);
}

module.exports = {
  enqueue, enqueueResultSync, resultSyncKey, claimNext, markDone, markSuperseded, markFailed,
  saveProgress, releaseStaleLocks, retryTask, backoffMs, safeErrorMessage, isDuplicateKeyError,
};
