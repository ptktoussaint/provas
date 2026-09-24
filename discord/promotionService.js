const crypto = require('crypto');
const mongoose = require('mongoose');
const PromotionDraft = require('../models/PromotionDraft');
const Promotion = require('../models/Promotion');
const ExamAttempt = require('../models/ExamAttempt');
const DiscordTask = require('../models/DiscordTask');
const { FINISHED_STATUSES, COMPUTED_FIELDS_STAGE, effectiveScore, maxScoreOf, isFinished } = require('../lib/results');
const { enqueue, isDuplicateKeyError } = require('../lib/outbox');
const { logSecurityEvent } = require('../lib/securityLog');
const { validateRpInput } = require('./nickname');
const { preflightPromotion } = require('./preflight');
const { TERMINAL_PROMOTION } = require('./processors');
const { applySelection } = require('./selection');

// Regras do "Promover", separadas das telas do Discord. Rascunhos ficam no
// Mongo, pertencem a um operador + servidor e expiram por inatividade.

const DRAFT_TTL_MS = 60 * 60 * 1000;
const { MAX_SELECTIONS } = require('./selection');
const CANDIDATES_PAGE = 25;

function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

function lockKeyFor(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function getOrCreateDraft(guildId, operatorId) {
  const now = new Date();
  const existing = await PromotionDraft.findOne({ guildId, operatorId, status: { $in: ['draft', 'review'] } }).sort({ updatedAt: -1 });
  if (existing) {
    if (existing.expiresAt > now) {
      existing.expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
      await existing.save();
      return existing;
    }
    existing.status = 'expired';
    await existing.save();
  }
  return PromotionDraft.create({ guildId, operatorId, expiresAt: new Date(now.getTime() + DRAFT_TTL_MS) });
}

async function loadDraft(draftId, { guildId, operatorId }, { editable = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(draftId)) throw userError('Rascunho inválido.');
  const draft = await PromotionDraft.findOne({ _id: draftId, guildId });
  if (!draft) throw userError('Rascunho não encontrado.');
  if (operatorId && draft.operatorId !== operatorId) throw userError('Este rascunho pertence a outro operador.');
  if (['draft', 'review'].includes(draft.status)) {
    if (draft.expiresAt <= new Date()) {
      draft.status = 'expired';
      await draft.save();
      throw userError('Este rascunho expirou por inatividade. Clique em **Promover** no painel para começar outro — nenhum membro foi alterado.');
    }
    draft.expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    await PromotionDraft.updateOne({ _id: draft._id }, { $set: { expiresAt: draft.expiresAt } });
  }
  if (editable && !['draft', 'review'].includes(draft.status)) {
    throw userError(draft.status === 'cancelled' ? 'Este rascunho foi cancelado.' : 'Este rascunho já foi confirmado — não pode mais ser editado.');
  }
  return draft;
}

async function lockedUserIds(guildId) {
  return Promotion.distinct('discordUserId', { guildId, lockKey: { $exists: true } });
}

// Resultados válidos (finalizados, não excluídos, vinculados neste
// servidor) de quem ainda não foi promovido por esta integração. Várias
// tentativas do mesmo usuário aparecem juntas (histórico).
async function listCandidates(guildId, { filterUserId = null, page = 0 } = {}) {
  const locked = await lockedUserIds(guildId);
  const match = { discordGuildId: guildId, deletedAt: null, status: { $in: FINISHED_STATUSES } };
  if (filterUserId) {
    if (locked.includes(filterUserId)) return { items: [], total: 0, page: 0, pages: 1, locked, filteredUserLocked: true };
    match.discordUserId = filterUserId;
  } else {
    match.discordUserId = { $ne: null, $nin: locked };
  }
  const total = await ExamAttempt.countDocuments(match);
  const pages = Math.max(1, Math.ceil(total / CANDIDATES_PAGE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const items = await ExamAttempt.aggregate([
    { $match: match },
    COMPUTED_FIELDS_STAGE,
    { $project: { snapshot: 0, auditTrail: 0, streamEvents: 0, focusEvents: 0 } },
    { $sort: { discordUserId: 1, finishedAt: -1 } },
    { $skip: safePage * CANDIDATES_PAGE },
    { $limit: CANDIDATES_PAGE },
  ]);
  await ExamAttempt.populate(items, { path: 'examId', select: 'name' });
  return { items, total, page: safePage, pages, locked, filteredUserLocked: false };
}

async function saveSelections(draft, selections) {
  draft.selections = selections;
  draft.status = 'draft';
  draft.reviewHash = null;
  draft.review = null;
  await draft.save();
  return draft;
}

function nextUnfilled(draft) {
  return draft.selections.find((s) => !s.nomeRP || !s.idRP) || null;
}

async function setRpData(draft, userId, { nome, idRP }, template) {
  const selection = draft.selections.find((s) => s.discordUserId === userId);
  if (!selection) throw userError('Esta pessoa não está mais no lote.');
  const v = validateRpInput({ nome, idRP, template });
  if (!v.ok) return { ok: false, errors: v.errors };
  selection.nomeRP = v.nome;
  selection.idRP = v.idRP;
  draft.status = 'draft';
  draft.reviewHash = null;
  draft.review = null;
  await draft.save();
  return { ok: true, nickname: v.nickname };
}

// Monta a verificação prévia com dados ATUAIS: resultados no Mongo,
// membros/cargos/permissões no Discord.
async function buildReport(draft, ctx) {
  const config = await ctx.getConfig({ fresh: true });
  const promo = config.promotion;
  const guild = await ctx.adapter.guildSnapshot(draft.guildId, {
    roleIds: Array.from(new Set([...promo.addRoleIds, ...promo.removeRoleIds, promo.announceRoleId].filter(Boolean))),
    announceChannelId: promo.announceChannelId,
  });

  const entries = [];
  for (const s of draft.selections) {
    const attempt = await ExamAttempt.findById(s.attemptId).select('status deletedAt discordUserId discordGuildId revision score adjustedScore maxScore pointsPerQuestion snapshot.order').lean();
    const member = await ctx.adapter.fetchMember(draft.guildId, s.discordUserId);
    const alreadyPromoted = Boolean(await Promotion.exists({ lockKey: lockKeyFor(draft.guildId, s.discordUserId) }));
    entries.push({
      userId: s.discordUserId,
      nomeRP: s.nomeRP,
      idRP: s.idRP,
      member,
      alreadyPromoted,
      selection: { revisionAtSelection: s.revisionAtSelection, scoreAtSelection: s.scoreAtSelection },
      result: attempt ? {
        exists: true,
        deleted: Boolean(attempt.deletedAt),
        finished: isFinished(attempt),
        discordUserId: attempt.discordUserId,
        guildId: attempt.discordGuildId,
        revision: attempt.revision || 0,
        effectiveScore: effectiveScore(attempt),
        maxScore: maxScoreOf(attempt),
      } : { exists: false },
    });
  }
  const report = preflightPromotion({ config, guild, entries });
  return { report, entries, config, guild };
}

function reviewHash({ draft, config, report }) {
  const payload = {
    sel: draft.selections.map((s) => [s.discordUserId, String(s.attemptId), s.revisionAtSelection, s.nomeRP, s.idRP]),
    promo: config.promotion,
    plan: report.entries.map((e) => [e.userId, e.nickname, e.preexisting, e.plan && e.plan.add, e.plan && e.plan.remove, e.errors.length]),
    blockers: report.globalErrors.length,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function summarizeReport(report, entries) {
  return {
    at: new Date(),
    ok: report.ok,
    globalErrors: report.globalErrors,
    globalWarnings: report.globalWarnings,
    entries: report.entries.map((e, i) => ({
      userId: e.userId,
      errors: e.errors,
      warnings: e.warnings,
      nickname: e.nickname,
      preexisting: e.preexisting,
      plan: e.plan,
      score: entries[i].result.effectiveScore,
      maxScore: entries[i].result.maxScore,
    })),
  };
}

// Revisão: se a nota mudou desde a seleção, adota o valor atual (e avisa)
// — é exatamente isto que o operador passa a ver e confirma.
async function reviewDraft(draft, ctx) {
  const { report, entries, config } = await buildReport(draft, ctx);
  for (const [i, e] of report.entries.entries()) {
    if (e.needsReReview) {
      const s = draft.selections[i];
      s.revisionAtSelection = entries[i].result.revision;
      s.scoreAtSelection = entries[i].result.effectiveScore;
    }
  }
  draft.status = 'review';
  draft.review = summarizeReport(report, entries);
  draft.reviewHash = reviewHash({ draft, config, report });
  await draft.save();
  return { draft, report };
}

function buildSteps(config, nickname) {
  return [
    ...config.promotion.addRoleIds.map((roleId) => ({ type: 'addRole', roleId })),
    ...config.promotion.removeRoleIds.map((roleId) => ({ type: 'removeRole', roleId })),
    { type: 'setNickname', nickname },
  ];
}

// Confirmação: transição atômica review → executing (clique duplo não
// executa duas vezes), revalidação completa e, só então, criação das
// promoções + tarefas na fila. Se algo mudou desde a revisão, volta para
// a revisão com os dados novos e exige nova confirmação.
async function confirmDraft(draftId, { guildId, operatorId }, hash, ctx) {
  await loadDraft(draftId, { guildId, operatorId });
  const claimed = await PromotionDraft.findOneAndUpdate(
    { _id: draftId, guildId, operatorId, status: 'review', reviewHash: hash, expiresAt: { $gt: new Date() } },
    { $set: { status: 'executing', confirmedAt: new Date() } },
    { new: true },
  );
  if (!claimed) {
    const current = await PromotionDraft.findById(draftId);
    if (current && ['executing', 'completed', 'partial'].includes(current.status)) return { kind: 'already', draft: current };
    return { kind: 'stale', draft: current };
  }

  let built;
  try {
    built = await buildReport(claimed, ctx);
  } catch (err) {
    await PromotionDraft.updateOne({ _id: claimed._id }, { $set: { status: 'review' } });
    throw err;
  }
  const { report, entries, config } = built;
  const newHash = reviewHash({ draft: claimed, config, report });
  if (!report.ok || newHash !== hash || report.entries.some((e) => e.needsReReview)) {
    for (const [i, e] of report.entries.entries()) {
      if (e.needsReReview) {
        claimed.selections[i].revisionAtSelection = entries[i].result.revision;
        claimed.selections[i].scoreAtSelection = entries[i].result.effectiveScore;
      }
    }
    claimed.status = 'review';
    claimed.confirmedAt = null;
    claimed.review = summarizeReport(report, entries);
    claimed.reviewHash = reviewHash({ draft: claimed, config, report });
    claimed.notice = 'Algo mudou desde a revisão (nota, resultado, cargos, permissões ou membros). Confira de novo e confirme outra vez.';
    await claimed.save();
    return { kind: 'changed', draft: claimed, report };
  }

  const created = [];
  const skipped = [];
  for (const [i, s] of claimed.selections.entries()) {
    const e = report.entries[i];
    try {
      const promo = await Promotion.create({
        guildId,
        discordUserId: s.discordUserId,
        lockKey: lockKeyFor(guildId, s.discordUserId),
        draftId: claimed._id,
        attemptId: s.attemptId,
        scoreAtPromotion: entries[i].result.effectiveScore,
        maxScore: entries[i].result.maxScore,
        operatorId,
        nomeRP: s.nomeRP,
        idRP: s.idRP,
        nickname: e.nickname,
        preexisting: e.preexisting,
        steps: buildSteps(config, e.nickname),
      });
      created.push(promo);
    } catch (err) {
      if (isDuplicateKeyError(err)) skipped.push(s.discordUserId);
      else throw err;
    }
  }

  for (const promo of created) {
    await enqueue({ key: `promote:${promo._id}:0`, kind: 'promotion_execute', promotionId: promo._id, draftId: claimed._id });
  }
  await logSecurityEvent('discord_promotion_confirmed', {
    meta: { draftId: claimed._id.toString(), operatorId, users: created.map((p) => p.discordUserId), skippedAlreadyPromoted: skipped },
  });

  if (!created.length) {
    claimed.status = 'cancelled';
    claimed.notice = 'Ninguém foi promovido: todos já tinham sido promovidos por outra operação ao mesmo tempo.';
    await claimed.save();
  }
  if (ctx.kickWorker) ctx.kickWorker();
  return { kind: 'started', draft: claimed, created, skipped };
}

async function cancelDraft(draftId, scope) {
  const draft = await loadDraft(draftId, scope, { editable: true });
  draft.status = 'cancelled';
  await draft.save();
  return draft;
}

// Retomada: só as etapas que falharam voltam para "pendente"; as feitas
// ficam como estão. O processador ainda confere o estado real do membro
// antes de cada etapa.
async function resumePromotion(promotionId, actor) {
  const promo = await Promotion.findById(promotionId);
  if (!promo) throw userError('Promoção não encontrada.');
  if (!['partial', 'failed'].includes(promo.status)) return { kind: 'nothing', promo };

  const update = {
    $set: {
      status: 'pending',
      lastError: null,
      steps: promo.steps.map((s) => {
        const o = s.toObject ? s.toObject() : s;
        return o.status === 'failed' ? { ...o, status: 'pending', error: null } : o;
      }),
      announceTaskKey: promo.announced ? promo.announceTaskKey : null,
    },
    $inc: { retryCount: 1 },
  };
  if (!promo.lockKey) update.$set.lockKey = lockKeyFor(promo.guildId, promo.discordUserId);
  try {
    await Promotion.updateOne({ _id: promo._id, status: promo.status }, update);
  } catch (err) {
    if (isDuplicateKeyError(err)) return { kind: 'locked', promo };
    throw err;
  }
  await PromotionDraft.updateOne({ _id: promo.draftId }, { $set: { status: 'executing' } });
  await enqueue({ key: `promote:${promo._id}:r${(promo.retryCount || 0) + 1}`, kind: 'promotion_execute', promotionId: promo._id, draftId: promo.draftId });
  await logSecurityEvent('discord_promotion_resumed', { meta: { promotionId: promo._id.toString(), discordUserId: promo.discordUserId, by: actor } });
  return { kind: 'resumed', promo };
}

async function resumeDraft(draftId, scope, actor) {
  const draft = await loadDraft(draftId, scope);
  const promos = await Promotion.find({ draftId: draft._id, status: { $in: ['partial', 'failed'] } }).select('_id');
  const out = [];
  for (const p of promos) out.push(await resumePromotion(p._id, actor));
  return out;
}

// Resolução administrativa (só pelo painel do site): libera o usuário para
// uma nova promoção por esta integração. Não mexe em cargos no Discord.
async function releasePromotion(promotionId, { actor, reason }) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw Object.assign(new Error('Informe o motivo (pelo menos 3 caracteres).'), { status: 400 });
  const promo = await Promotion.findOneAndUpdate(
    { _id: promotionId, lockKey: { $exists: true }, status: { $nin: ['pending', 'in_progress'] } },
    { $unset: { lockKey: 1 }, $set: { resolvedAdministratively: { by: actor, at: new Date(), reason: why.slice(0, 500) } } },
    { new: true },
  );
  if (!promo) throw Object.assign(new Error('Promoção não encontrada, já liberada ou ainda em execução.'), { status: 409 });
  await logSecurityEvent('discord_promotion_released', { meta: { promotionId: String(promotionId), discordUserId: promo.discordUserId, by: actor, reason: why.slice(0, 500) } });
  return promo;
}

async function draftProgress(draftId) {
  const promotions = await Promotion.find({ draftId }).sort({ createdAt: 1 }).lean();
  const announces = await DiscordTask.find({ draftId, kind: 'promotion_announce' }).select('status lastError key').lean();
  const done = promotions.every((p) => TERMINAL_PROMOTION.includes(p.status));
  return { promotions, announces, done };
}

async function waitForDraft(draftId, timeoutMs = 8000) {
  const start = Date.now();
  let progress = await draftProgress(draftId);
  while (!progress.done && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 800));
    progress = await draftProgress(draftId);
  }
  return progress;
}

module.exports = {
  getOrCreateDraft, loadDraft, listCandidates, applySelection, saveSelections, nextUnfilled, setRpData,
  buildReport, reviewDraft, reviewHash, confirmDraft, cancelDraft, resumePromotion, resumeDraft, releasePromotion,
  draftProgress, waitForDraft, lockKeyFor, userError, MAX_SELECTIONS, CANDIDATES_PAGE, DRAFT_TTL_MS,
};
