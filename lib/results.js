const mongoose = require('mongoose');
const ExamAttempt = require('../models/ExamAttempt');
const Exam = require('../models/Exam');
const Room = require('../models/Room');
const Promotion = require('../models/Promotion');
const { enqueueResultSync } = require('./outbox');
const { isSnowflake } = require('./discordIds');

const FINISHED_STATUSES = ['finished', 'finished_timeout'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Pontuação máxima da tentativa, congelada quando ela foi realizada. Para
// tentativas anteriores a este campo, o mesmo cálculo a partir do snapshot
// (também congelado) dá exatamente o mesmo valor.
function maxScoreOf(attempt) {
  if (attempt.maxScore != null) return attempt.maxScore;
  const count = attempt.snapshot ? attempt.snapshot.length : (attempt.snapshotCount || 0);
  return count * (attempt.pointsPerQuestion || 0);
}

function effectiveScore(attempt) {
  return attempt.adjustedScore != null ? attempt.adjustedScore : (attempt.score || 0);
}

function isFinished(attempt) {
  return FINISHED_STATUSES.includes(attempt.status);
}

// Campos calculados no próprio Mongo (sem trazer o snapshot inteiro).
const COMPUTED_FIELDS_STAGE = {
  $addFields: {
    maxScoreComputed: {
      $ifNull: ['$maxScore', { $multiply: [{ $size: { $ifNull: ['$snapshot', []] } }, { $ifNull: ['$pointsPerQuestion', 0] }] }],
    },
    effectiveScore: { $ifNull: ['$adjustedScore', { $ifNull: ['$score', 0] }] },
  },
};

function normalizeReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < 3) throw httpError(400, 'Informe o motivo (pelo menos 3 caracteres).');
  return text.slice(0, 500);
}

// Promoções já executadas que usaram este resultado — editar/excluir a
// nota NÃO desfaz a promoção (nenhum cargo é removido automaticamente).
async function promotionsUsingAttempt(attemptId) {
  return Promotion.find({ attemptId, status: { $in: ['completed', 'partial', 'in_progress', 'pending'] } })
    .select('discordUserId status completedAt').lean();
}

function promotionWarning(promotions) {
  if (!promotions.length) return null;
  return 'Atenção: este resultado já foi usado numa promoção pelo Discord. A promoção NÃO é desfeita automaticamente — nenhum cargo foi removido. Ajuste os cargos manualmente no Discord se necessário.';
}

// Ajuste manual da nota: nunca mexe em acertos/respostas nem na nota
// calculada — só grava a nota ajustada (efetiva) com histórico.
// `score: null` remove o ajuste e volta para a nota calculada.
async function adjustScore({ attemptId, score, reason, actor }) {
  if (!mongoose.Types.ObjectId.isValid(attemptId)) throw httpError(400, 'ID inválido.');
  const why = normalizeReason(reason);
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) throw httpError(404, 'Tentativa não encontrada.');
  if (attempt.deletedAt) throw httpError(409, 'Este resultado foi excluído.');
  if (!isFinished(attempt)) throw httpError(409, 'Só é possível ajustar a nota de uma prova finalizada.');

  const max = maxScoreOf(attempt);
  let newAdjusted = null;
  if (score !== null && score !== undefined && score !== '') {
    const value = Number(score);
    if (!Number.isFinite(value)) throw httpError(400, 'Nota inválida.');
    if (value < 0 || value > max) throw httpError(400, `A nota precisa estar entre 0 e ${max} (pontuação máxima desta tentativa).`);
    if (Math.round(value * 100) !== value * 100) throw httpError(400, 'Use no máximo duas casas decimais.');
    newAdjusted = value;
  }

  const before = { score: attempt.score, adjustedScore: attempt.adjustedScore, effectiveScore: effectiveScore(attempt) };
  if (newAdjusted === attempt.adjustedScore) throw httpError(400, 'A nota informada é igual à atual.');
  const after = { score: attempt.score, adjustedScore: newAdjusted, effectiveScore: newAdjusted != null ? newAdjusted : attempt.score };

  const updated = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, revision: attempt.revision || 0, deletedAt: null },
    {
      $set: { adjustedScore: newAdjusted, maxScore: max },
      $inc: { revision: 1 },
      $push: { auditTrail: { type: newAdjusted == null ? 'score_adjustment_removed' : 'score_adjusted', by: actor, reason: why, before, after } },
    },
    { new: true },
  );
  if (!updated) throw httpError(409, 'O resultado foi alterado por outra ação ao mesmo tempo. Recarregue e tente de novo.');

  await enqueueResultSync(updated);
  const warning = promotionWarning(await promotionsUsingAttempt(updated._id));
  return { attempt: updated, before, after, warning };
}

// Exclusão lógica: some das consultas e das promoções, mas continua no
// banco (auditoria restrita ao admin). A sala volta a aceitar uma nova
// tentativa, como antes.
async function softDeleteResult({ attemptId, reason, actor }) {
  if (!mongoose.Types.ObjectId.isValid(attemptId)) throw httpError(400, 'ID inválido.');
  const why = normalizeReason(reason);
  const attempt = await ExamAttempt.findById(attemptId).select('-snapshot');
  if (!attempt) throw httpError(404, 'Tentativa não encontrada.');
  if (attempt.deletedAt) throw httpError(409, 'Este resultado já foi excluído.');

  const before = { status: attempt.status, score: attempt.score, adjustedScore: attempt.adjustedScore };
  const updated = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, deletedAt: null },
    {
      $set: { deletedAt: new Date(), deletedBy: actor, deleteReason: why },
      $inc: { revision: 1 },
      $push: { auditTrail: { type: 'result_deleted', by: actor, reason: why, before, after: { deleted: true } } },
    },
    { new: true, projection: { snapshot: 0 } },
  );
  if (!updated) throw httpError(409, 'Este resultado já foi excluído.');

  await Room.findOneAndUpdate(
    { _id: attempt.roomId, currentAttemptId: attempt._id },
    { currentAttemptId: null, status: 'pending' },
  );

  await enqueueResultSync(updated);
  const warning = promotionWarning(await promotionsUsingAttempt(updated._id));
  return { attempt: updated, warning };
}

// Vinculação explícita (feita pelo admin) de um resultado a um usuário do
// Discord — nunca por adivinhação de nome. Não publica aviso de "prova
// finalizada" (wantsMessage continua como estava).
async function linkDiscordUser({ attemptId, discordUserId, guildId, reason, actor }) {
  if (!mongoose.Types.ObjectId.isValid(attemptId)) throw httpError(400, 'ID inválido.');
  const why = normalizeReason(reason);
  const userId = String(discordUserId || '').trim();
  if (!isSnowflake(userId)) throw httpError(400, 'ID do Discord inválido (deve ter 17 a 20 dígitos).');
  if (!guildId) throw httpError(409, 'DISCORD_GUILD_ID não está configurado no servidor.');

  const attempt = await ExamAttempt.findById(attemptId).select('-snapshot');
  if (!attempt) throw httpError(404, 'Tentativa não encontrada.');
  if (attempt.deletedAt) throw httpError(409, 'Este resultado foi excluído.');
  if (attempt.discordUserId === userId) throw httpError(400, 'O resultado já está vinculado a este usuário.');

  const before = { discordUserId: attempt.discordUserId, discordGuildId: attempt.discordGuildId };
  const updated = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, revision: attempt.revision || 0 },
    {
      $set: { discordUserId: userId, discordGuildId: guildId },
      $inc: { revision: 1 },
      $push: { auditTrail: { type: 'discord_linked', by: actor, reason: why, before, after: { discordUserId: userId, discordGuildId: guildId } } },
    },
    { new: true, projection: { snapshot: 0 } },
  );
  if (!updated) throw httpError(409, 'O resultado foi alterado por outra ação ao mesmo tempo. Recarregue e tente de novo.');
  await enqueueResultSync(updated);
  return { attempt: updated, before };
}

// Lista do admin: por padrão sem os excluídos; com includeDeleted mostra
// tudo (auditoria).
async function listForAdmin({ examId = null, status = null, includeDeleted = false } = {}) {
  const match = {};
  if (examId && mongoose.Types.ObjectId.isValid(examId)) match.examId = new mongoose.Types.ObjectId(examId);
  if (status) match.status = String(status);
  if (!includeDeleted) match.deletedAt = null;

  const docs = await ExamAttempt.aggregate([
    { $match: match },
    COMPUTED_FIELDS_STAGE,
    { $project: { snapshot: 0, auditTrail: 0, streamEvents: 0, focusEvents: 0 } },
    { $sort: { createdAt: -1 } },
  ]);
  await ExamAttempt.populate(docs, [
    { path: 'roomId', select: 'roomLabel studentName' },
    { path: 'examId', select: 'name' },
  ]);
  return docs;
}

const DISCORD_SORTS = {
  'date-desc': { finishedAt: -1, _id: -1 },
  'date-asc': { finishedAt: 1, _id: 1 },
  'score-desc': { effectiveScore: -1, finishedAt: -1 },
  'score-asc': { effectiveScore: 1, finishedAt: -1 },
};

// Consulta usada pelo botão "Conferir resultados": sempre lê o estado atual
// do Mongo (nada em memória). Inclui resultados antigos sem vínculo (como
// "não vinculado"), mas nunca os excluídos.
async function listForDiscord({ guildId, userId = null, examId = null, sort = 'date-desc', page = 0, pageSize = 8 }) {
  const match = { deletedAt: null, status: { $in: FINISHED_STATUSES } };
  if (userId) {
    match.discordUserId = userId;
    match.discordGuildId = guildId;
  } else {
    match.$or = [{ discordGuildId: guildId }, { discordUserId: null }];
  }
  if (examId && mongoose.Types.ObjectId.isValid(examId)) match.examId = new mongoose.Types.ObjectId(examId);

  const total = await ExamAttempt.countDocuments(match);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);

  const docs = await ExamAttempt.aggregate([
    { $match: match },
    COMPUTED_FIELDS_STAGE,
    { $project: { snapshot: 0, auditTrail: 0, streamEvents: 0, focusEvents: 0 } },
    { $sort: DISCORD_SORTS[sort] || DISCORD_SORTS['date-desc'] },
    { $skip: safePage * pageSize },
    { $limit: pageSize },
  ]);
  await ExamAttempt.populate(docs, { path: 'examId', select: 'name' });

  const promotions = await promotionMap(guildId, docs.map((d) => d.discordUserId).filter(Boolean));
  return { items: docs, total, page: safePage, pages, promotions };
}

// Estado de promoção por usuário (a mais relevante: a que ainda conta
// como "promovido por esta integração", senão a mais recente).
async function promotionMap(guildId, userIds) {
  const unique = Array.from(new Set(userIds));
  if (!unique.length) return new Map();
  const promos = await Promotion.find({ guildId, discordUserId: { $in: unique } })
    .sort({ createdAt: -1 }).select('discordUserId status lockKey completedAt attemptId createdAt').lean();
  const map = new Map();
  for (const p of promos) {
    const current = map.get(p.discordUserId);
    if (!current || (!current.lockKey && p.lockKey)) map.set(p.discordUserId, p);
  }
  return map;
}

async function examNameMap(examIds) {
  const exams = await Exam.find({ _id: { $in: examIds } }).select('name').lean();
  return new Map(exams.map((e) => [e._id.toString(), e.name]));
}

module.exports = {
  FINISHED_STATUSES, maxScoreOf, effectiveScore, isFinished, adjustScore, softDeleteResult,
  linkDiscordUser, listForAdmin, listForDiscord, promotionMap, examNameMap, COMPUTED_FIELDS_STAGE,
  promotionsUsingAttempt,
};
