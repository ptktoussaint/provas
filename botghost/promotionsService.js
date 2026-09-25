const crypto = require('crypto');
const mongoose = require('mongoose');
const PromotionDraft = require('../models/PromotionDraft');
const Promotion = require('../models/Promotion');
const ExamAttempt = require('../models/ExamAttempt');
const IntegrationNotification = require('../models/IntegrationNotification');
const { FINISHED_STATUSES, COMPUTED_FIELDS_STAGE, effectiveScore, maxScoreOf, isFinished } = require('../lib/results');
const { logSecurityEvent } = require('../lib/securityLog');
const { isSnowflake } = require('../lib/discordIds');
const { validateRpInput, validateTemplate } = require('./nickname');
const { applySelection, selectionFromCandidate, MAX_SELECTIONS } = require('./selection');
const { chunkUserIds } = require('./announce');
const notifications = require('./notifications');
const { ApiError, boolText } = require('./http');
const { baseContext, renderForApi } = require('./messages');
const { userText, fmtNumber, fmtDate, mention, roleMention, truncate } = require('./format');

// Promoção em lote pedida pelo BotGhost. O site guarda rascunhos, lotes,
// travas e o histórico de cada etapa; quem mexe no Discord (cargos,
// apelido, anúncio) é o bot do BotGhost, que relata aqui o resultado e o
// estado lido do membro. O site só marca uma etapa como feita quando o
// estado relatado confirma — mas isso continua sendo um relato do executor
// autenticado, não uma leitura independente do site.

const DRAFT_TTL_MS = 60 * 60 * 1000;
const JOB_LEASE_MS = 10 * 60 * 1000;
const CANDIDATES_PAGE = 25;
const TERMINAL = ['completed', 'partial', 'failed', 'needs_review', 'blocked'];

function lockKeyFor(guildId, userId) {
  return `${guildId}:${userId}`;
}

// ---------------- Rascunho ----------------

async function getOrCreateDraft(actor) {
  const now = new Date();
  const existing = await PromotionDraft.findOne({ guildId: actor.guildId, operatorId: actor.actorDiscordId, status: { $in: ['draft', 'review'] } }).sort({ updatedAt: -1 });
  if (existing && existing.expiresAt > now) {
    existing.expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
    await existing.save();
    return { draft: existing, reused: true };
  }
  if (existing) { existing.status = 'expired'; await existing.save(); }
  const draft = await PromotionDraft.create({ guildId: actor.guildId, operatorId: actor.actorDiscordId, expiresAt: new Date(now.getTime() + DRAFT_TTL_MS) });
  return { draft, reused: false };
}

// Dono, servidor e prazo conferidos em TODA ação do rascunho.
async function loadOwnedDraft(actor, draftId, { editable = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(draftId)) throw new ApiError(400, 'invalid_field', 'draftId inválido.');
  const draft = await PromotionDraft.findOne({ _id: draftId, guildId: actor.guildId });
  if (!draft) throw new ApiError(404, 'draft_not_found', 'Rascunho não encontrado.');
  if (draft.operatorId !== actor.actorDiscordId) throw new ApiError(403, 'not_draft_owner', 'Este rascunho pertence a outro operador.');
  if (['draft', 'review'].includes(draft.status)) {
    if (draft.expiresAt <= new Date()) {
      draft.status = 'expired';
      await draft.save();
      throw new ApiError(410, 'draft_expired', 'Este rascunho expirou por inatividade. Clique em Promover para começar outro — nenhum membro foi alterado.');
    }
    draft.expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    await PromotionDraft.updateOne({ _id: draft._id }, { $set: { expiresAt: draft.expiresAt } });
  }
  if (editable && !['draft', 'review'].includes(draft.status)) {
    throw new ApiError(409, 'draft_not_editable', draft.status === 'cancelled' ? 'Este rascunho foi cancelado.' : 'Este rascunho já foi confirmado e não pode ser editado.');
  }
  return draft;
}

async function lockedUserIds(guildId) {
  return Promotion.distinct('discordUserId', { guildId, lockKey: { $exists: true } });
}

// Resultados válidos (finalizados, não excluídos, vinculados a este
// servidor) de quem ainda não foi promovido pela integração. Tentativas do
// mesmo usuário aparecem juntas (histórico).
async function listCandidates(guildId, { studentDiscordId = null, page = 0 } = {}) {
  const locked = await lockedUserIds(guildId);
  const match = { discordGuildId: guildId, deletedAt: null, archivedAt: null, status: { $in: FINISHED_STATUSES } };
  if (studentDiscordId) {
    if (locked.includes(studentDiscordId)) return { items: [], total: 0, page: 0, pages: 1, locked };
    match.discordUserId = studentDiscordId;
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
  return { items, total, page: safePage, pages, locked };
}

// Menu dinâmico: 25 opções fixas no bloco do BotGhost ligadas a estas
// variáveis (label/descrição/valor/esconder/pré-selecionado).
function candidateSlots(items, selectedAttemptIds) {
  const slots = {};
  for (let i = 0; i < CANDIDATES_PAGE; i += 1) {
    const c = items[i];
    const n = i + 1;
    slots[`opt${n}Label`] = c ? truncate(`${c.studentName} — ${fmtNumber(c.effectiveScore)}/${fmtNumber(c.maxScoreComputed)} — ${c.examId && c.examId.name ? c.examId.name : '—'}`, 100) : '-';
    slots[`opt${n}Description`] = c ? truncate(`ID ${c.discordUserId} · ${fmtDate(c.finishedAt)} · tentativa ${String(c._id).slice(-6)}${c.oralScore != null ? ` · prova ${fmtNumber(c.writtenScore)} + oral ${fmtNumber(c.oralScore)}` : ''}`, 100) : '-';
    slots[`opt${n}Value`] = c ? String(c._id) : `vazio-${n}`;
    slots[`opt${n}Hide`] = boolText(!c);
    slots[`opt${n}Default`] = boolText(Boolean(c && selectedAttemptIds.has(String(c._id))));
  }
  return slots;
}

function selectionLines(draft, template) {
  return draft.selections.map((s) => {
    const rp = s.nomeRP && s.idRP ? `\`${template.replace(/\{nome\}/g, s.nomeRP).replace(/\{idRP\}/g, s.idRP)}\`` : '⚠️ RP pendente';
    return `• ${mention(s.discordUserId)} — ${userText(s.studentName, 30)} — ${fmtNumber(s.scoreAtSelection)}/${fmtNumber(s.maxScore)} — ${userText(s.examName || '—', 30)} — tentativa \`${String(s.attemptId).slice(-6)}\` — ${rp}`;
  });
}

function nextUnfilled(draft) {
  return draft.selections.find((s) => !s.nomeRP || !s.idRP) || null;
}

async function draftView(actor, draft, { page = 0, studentDiscordId = null } = {}) {
  const cands = await listCandidates(draft.guildId, { studentDiscordId, page });
  const selected = new Set(draft.selections.map((s) => String(s.attemptId)));
  const template = actor.config.promotion.nicknameTemplate;
  const next = nextUnfilled(draft);
  const selLines = selectionLines(draft, template);
  const candLines = cands.items.map((c, i) => `\`${i + 1}\` ${userText(c.studentName, 40)} — ${fmtNumber(c.effectiveScore)}/${fmtNumber(c.maxScoreComputed)} — ${userText(c.examId && c.examId.name ? c.examId.name : '—', 30)} — ${fmtDate(c.finishedAt)}${selected.has(String(c._id)) ? ' ✅' : ''}`);
  const msg = await renderForApi('promotion_selection', {
    ...baseContext(actor),
    'selecao.lista': selLines.join('\n') || '_ninguém ainda_',
    'selecao.total': `${draft.selections.length}/${MAX_SELECTIONS}`,
    'candidatos.lista': candLines.join('\n') || '_nenhum candidato nesta página_',
    'pagina.atual': String(cands.page + 1),
    'pagina.total': String(cands.pages),
    'proximo.mencao': next ? mention(next.discordUserId) : '—',
    'proximo.nome': next ? userText(next.studentName, 40) : 'todos preenchidos',
  });
  return {
    draftId: String(draft._id),
    draftStatus: draft.status,
    expiresAt: draft.expiresAt,
    selectedCount: String(draft.selections.length),
    maxSelections: String(MAX_SELECTIONS),
    candidatesTotal: String(cands.total),
    page: String(cands.page),
    pageNumber: String(cands.page + 1),
    pages: String(cands.pages),
    hasPrevious: boolText(cands.page > 0),
    hasNext: boolText(cands.page < cands.pages - 1),
    previousPage: String(Math.max(0, cands.page - 1)),
    nextPage: String(Math.min(cands.pages - 1, cands.page + 1)),
    candidatesOnPage: String(cands.items.length),
    lockedCount: String(cands.locked.length),
    hasUnfilled: boolText(Boolean(next)),
    nextDiscordUserId: next ? next.discordUserId : '',
    nextMention: next ? mention(next.discordUserId) : '',
    nextStudentName: next ? next.studentName : '',
    nextNomeRP: next && next.nomeRP ? next.nomeRP : '',
    nextIdRP: next && next.idRP ? next.idRP : '',
    readyForReview: boolText(draft.selections.length > 0 && !next),
    displayText: `Selecionados (${draft.selections.length}/${MAX_SELECTIONS}):\n${selLines.join('\n') || 'ninguém ainda'}\n\nCandidatos (página ${cands.page + 1}/${cands.pages}):\n${candLines.join('\n') || 'nenhum'}`,
    ...candidateSlots(cands.items, selected),
    ...msg,
  };
}

// Seleção. Modo A (menu dinâmico): attemptIds da página — substitui as
// marcações daquela página, mantendo as outras. Modo B (menu de usuários):
// discordUserIds — valida TODOS antes de aceitar; quem tiver mais de um
// resultado válido precisa ser escolhido pelo resultado (modo A).
async function updateSelection(actor, draftId, { page, attemptIds, discordUserIds, removeDiscordUserIds }) {
  const draft = await loadOwnedDraft(actor, draftId, { editable: true });
  let selections = draft.selections.map((s) => (s.toObject ? s.toObject() : s));

  if (removeDiscordUserIds.length) selections = selections.filter((s) => !removeDiscordUserIds.includes(s.discordUserId));

  if (attemptIds.length || (!discordUserIds.length && !removeDiscordUserIds.length)) {
    const cands = await listCandidates(actor.guildId, { page });
    const pageIds = new Set(cands.items.map((c) => String(c._id)));
    const foreign = attemptIds.filter((id) => !pageIds.has(id));
    if (foreign.length) throw new ApiError(422, 'not_eligible', 'Algum resultado marcado não está mais entre os candidatos desta página (mudou, foi excluído ou a pessoa já foi promovida). Atualize a lista.', { invalid: foreign.join(',') });
    const out = applySelection(selections, { pageCandidates: cands.items, chosenIds: attemptIds });
    if (out.error) throw new ApiError(422, 'selection_invalid', out.error);
    selections = out.selections;
  }

  if (discordUserIds.length) {
    const problems = [];
    const toAdd = [];
    for (const uid of discordUserIds) {
      if (selections.some((s) => s.discordUserId === uid)) continue;
      const { items } = await listCandidates(actor.guildId, { studentDiscordId: uid });
      if (!items.length) problems.push(`${mention(uid)}: sem resultado válido para promoção (ou já promovido pela integração).`);
      else if (items.length > 1) problems.push(`${mention(uid)}: tem ${items.length} resultados — escolha qual vale pela lista de candidatos.`);
      else toAdd.push(items[0]);
    }
    if (problems.length) throw new ApiError(422, 'selection_invalid', `Nada foi alterado. Corrija:\n${problems.join('\n')}`);
    for (const c of toAdd) selections.push(selectionFromCandidate(c, null));
    if (selections.length > MAX_SELECTIONS) throw new ApiError(422, 'selection_invalid', `O lote pode ter no máximo ${MAX_SELECTIONS} pessoas.`);
  }

  draft.selections = selections;
  draft.status = 'draft';
  draft.reviewHash = null;
  draft.review = null;
  await draft.save();
  return draft;
}

async function setMember(actor, draftId, { discordUserId, nomeRP, idRP }) {
  const draft = await loadOwnedDraft(actor, draftId, { editable: true });
  const sel = draft.selections.find((s) => s.discordUserId === discordUserId);
  if (!sel) throw new ApiError(404, 'member_not_in_draft', 'Esta pessoa não está no lote.');
  const v = validateRpInput({ nome: nomeRP, idRP, template: actor.config.promotion.nicknameTemplate });
  if (!v.ok) throw new ApiError(422, 'rp_invalid', v.errors.join(' '), { discordUserId });
  sel.nomeRP = v.nome;
  sel.idRP = v.idRP; // texto: zeros à esquerda preservados
  draft.status = 'draft';
  draft.reviewHash = null;
  draft.review = null;
  await draft.save();
  return { draft, nickname: v.nickname };
}

// ---------------- Revisão e confirmação ----------------

async function siteChecks(actor, draft) {
  const promo = actor.config.promotion;
  const globalErrors = [];
  if (!promo.addRoleIds.length) globalErrors.push('Nenhum cargo a adicionar configurado.');
  if (!promo.announceChannelId) globalErrors.push('Canal de anúncio não configurado.');
  if (!promo.announceRoleId) globalErrors.push('Cargo do anúncio não configurado.');
  const tplErr = validateTemplate(promo.nicknameTemplate);
  if (tplErr) globalErrors.push(tplErr);
  if (!draft.selections.length) globalErrors.push('Nenhuma pessoa selecionada.');

  const entries = [];
  for (const s of draft.selections) {
    const errors = [];
    const warnings = [];
    const a = await ExamAttempt.findById(s.attemptId).select('status deletedAt archivedAt discordUserId discordGuildId revision score adjustedScore oralScore maxScore pointsPerQuestion snapshot.order').lean();
    let needsReReview = false;
    if (!a || a.deletedAt) errors.push('Resultado excluído ou inexistente.');
    else if (a.archivedAt) errors.push('Resultado arquivado (desarquive no admin para promover).');
    else if (!isFinished(a)) errors.push('Resultado não é de prova finalizada.');
    else if (a.discordUserId !== s.discordUserId || a.discordGuildId !== actor.guildId) errors.push('Resultado não está mais vinculado a esta pessoa.');
    else if ((a.revision || 0) !== s.revisionAtSelection) { needsReReview = true; warnings.push(`A nota mudou desde a seleção (agora ${fmtNumber(effectiveScore(a))}).`); }
    if (await Promotion.exists({ lockKey: lockKeyFor(actor.guildId, s.discordUserId) })) errors.push('Já promovido por esta integração (liberação só pelo admin).');
    const rp = validateRpInput({ nome: s.nomeRP, idRP: s.idRP, template: promo.nicknameTemplate });
    if (!s.nomeRP || !s.idRP) errors.push('NOME RP / ID RP não preenchidos.');
    else if (!rp.ok) errors.push(...rp.errors);
    entries.push({
      userId: s.discordUserId,
      errors,
      warnings,
      needsReReview,
      nickname: rp.nickname,
      revision: a ? a.revision || 0 : null,
      score: a ? effectiveScore(a) : null,
      maxScore: a ? maxScoreOf(a) : null,
    });
  }
  const ok = !globalErrors.length && entries.length > 0 && entries.every((e) => !e.errors.length);
  return { ok, globalErrors, entries };
}

function reviewHash(draft, config, report) {
  const payload = {
    sel: draft.selections.map((s) => [s.discordUserId, String(s.attemptId), s.revisionAtSelection, s.nomeRP, s.idRP]),
    promo: config.promotion,
    plan: report.entries.map((e) => [e.userId, e.nickname, e.errors.length]),
    g: report.globalErrors.length,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function adoptCurrent(draft, report) {
  report.entries.forEach((e, i) => {
    if (e.needsReReview) {
      draft.selections[i].revisionAtSelection = e.revision;
      draft.selections[i].scoreAtSelection = e.score;
    }
  });
}

async function reviewView(actor, draft, report) {
  const promo = actor.config.promotion;
  const lines = report.entries.map((e) => {
    let t = `• ${mention(e.userId)} → ${e.nickname ? `\`${e.nickname}\`` : '—'} · nota ${fmtNumber(e.score)}/${fmtNumber(e.maxScore)}`;
    for (const w of e.warnings) t += `\n  ⚠️ ${w}`;
    for (const x of e.errors) t += `\n  ⛔ ${x}`;
    return t;
  });
  const blockers = report.globalErrors.map((e) => `⛔ ${e}`).join('\n') || (report.ok ? 'Nenhum bloqueio no site. Cargos, hierarquia e membros são conferidos pelo bot na execução.' : '⛔ Há pessoas com bloqueio (veja abaixo).');
  const msg = await renderForApi('promotion_review', {
    ...baseContext(actor),
    'revisao.lista': lines.join('\n') || '—',
    'revisao.total': String(report.entries.length),
    'revisao.bloqueios': blockers,
    'promocao.cargoMencao': roleMention(promo.announceRoleId),
    'promocao.cargosAdicionar': promo.addRoleIds.map((id) => `+${roleMention(id)}`).join(' '),
    'promocao.cargosRemover': promo.removeRoleIds.map((id) => `−${roleMention(id)}`).join(' '),
  });
  return {
    draftId: String(draft._id),
    draftStatus: draft.status,
    canConfirm: boolText(report.ok),
    reviewHash: draft.reviewHash || '',
    blockersText: blockers,
    displayText: `${blockers}\n\n${lines.join('\n')}`,
    ...msg,
  };
}

async function review(actor, draftId) {
  const draft = await loadOwnedDraft(actor, draftId, { editable: true });
  const report = await siteChecks(actor, draft);
  adoptCurrent(draft, report);
  draft.status = 'review';
  draft.review = { at: new Date(), ok: report.ok, globalErrors: report.globalErrors, entries: report.entries };
  draft.reviewHash = reviewHash(draft, actor.config, report);
  await draft.save();
  return reviewView(actor, draft, report);
}

function buildSteps(config, nickname) {
  return [
    ...config.promotion.addRoleIds.map((roleId) => ({ type: 'addRole', roleId })),
    ...config.promotion.removeRoleIds.map((roleId) => ({ type: 'removeRole', roleId })),
    { type: 'setNickname', nickname },
  ];
}

// Confirmação: uma única vez (transição atômica review → executing) e com
// revalidação completa. Se algo mudou, volta para revisão.
async function confirm(actor, draftId, hash) {
  await loadOwnedDraft(actor, draftId);
  const claimed = await PromotionDraft.findOneAndUpdate(
    { _id: draftId, guildId: actor.guildId, operatorId: actor.actorDiscordId, status: 'review', reviewHash: hash, expiresAt: { $gt: new Date() } },
    { $set: { status: 'executing', confirmedAt: new Date() } },
    { new: true },
  );
  if (!claimed) {
    const cur = await PromotionDraft.findById(draftId);
    if (cur && ['executing', 'completed', 'partial'].includes(cur.status)) throw new ApiError(409, 'already_confirmed', 'Esta promoção já foi confirmada — nada foi executado de novo.', { jobId: String(cur._id) });
    throw new ApiError(409, 'review_outdated', 'Esta revisão não é mais a atual. Revise de novo antes de confirmar.');
  }
  const report = await siteChecks(actor, claimed);
  const newHash = reviewHash(claimed, actor.config, report);
  if (!report.ok || newHash !== hash || report.entries.some((e) => e.needsReReview)) {
    adoptCurrent(claimed, report);
    claimed.status = 'review';
    claimed.confirmedAt = null;
    claimed.review = { at: new Date(), ok: report.ok, globalErrors: report.globalErrors, entries: report.entries };
    claimed.reviewHash = reviewHash(claimed, actor.config, report);
    await claimed.save();
    const view = await reviewView(actor, claimed, report);
    throw new ApiError(409, 'changed_since_review', 'Algo mudou desde a revisão (nota, resultado, promoção ou configuração). Confira a nova revisão e confirme de novo.', view);
  }

  const created = [];
  const skipped = [];
  for (const [i, s] of claimed.selections.entries()) {
    const e = report.entries[i];
    try {
      created.push(await Promotion.create({
        guildId: actor.guildId,
        discordUserId: s.discordUserId,
        lockKey: lockKeyFor(actor.guildId, s.discordUserId),
        draftId: claimed._id,
        attemptId: s.attemptId,
        scoreAtPromotion: e.score,
        maxScore: e.maxScore,
        revisionAtConfirm: e.revision,
        operatorId: actor.actorDiscordId,
        nomeRP: s.nomeRP,
        idRP: s.idRP,
        nickname: e.nickname,
        steps: buildSteps(actor.config, e.nickname),
      }));
    } catch (err) {
      if (err && err.code === 11000) skipped.push(s.discordUserId);
      else throw err;
    }
  }
  await logSecurityEvent('botghost_promotion_confirmed', { meta: { draftId: String(claimed._id), operatorId: actor.actorDiscordId, users: created.map((p) => p.discordUserId), skipped } });
  if (!created.length) {
    claimed.status = 'cancelled';
    await claimed.save();
    throw new ApiError(409, 'nobody_to_promote', 'Ninguém a promover: todos já foram promovidos por outra operação ao mesmo tempo.');
  }
  return {
    jobId: String(claimed._id),
    itemCount: String(created.length),
    skippedCount: String(skipped.length),
    skippedText: skipped.map(mention).join(', '),
  };
}

// ---------------- Execução (job = rascunho confirmado) ----------------

async function loadOwnedJob(actor, jobId) {
  const draft = await loadOwnedDraft(actor, jobId);
  if (!['executing', 'completed', 'partial'].includes(draft.status)) throw new ApiError(409, 'job_not_confirmed', 'Esta promoção ainda não foi confirmada.');
  return draft;
}

function pendingSteps(item) {
  return item.steps.map((s, i) => ({ ...(s.toObject ? s.toObject() : s), index: i })).filter((s) => s.status === 'pending');
}

function itemInstructions(item, phase) {
  const pend = pendingSteps(item);
  const add = pend.filter((s) => s.type === 'addRole').map((s) => s.roleId);
  const rem = pend.filter((s) => s.type === 'removeRole').map((s) => s.roleId);
  const nick = pend.some((s) => s.type === 'setNickname');
  // Um slot fixo por cargo configurado: o fluxo do BotGhost tem um bloco
  // por slot e só executa quando addRoleN/removeRoleN não está vazio.
  const slots = {};
  const cfgAdd = item.steps.filter((st) => st.type === 'addRole').map((st) => st.roleId);
  const cfgRem = item.steps.filter((st) => st.type === 'removeRole').map((st) => st.roleId);
  for (let i = 0; i < 5; i += 1) {
    slots[`addRole${i + 1}`] = cfgAdd[i] && add.includes(cfgAdd[i]) ? cfgAdd[i] : '';
    slots[`removeRole${i + 1}`] = cfgRem[i] && rem.includes(cfgRem[i]) ? cfgRem[i] : '';
  }
  return {
    ...slots,
    itemId: String(item._id),
    memberDiscordId: item.discordUserId,
    memberMention: mention(item.discordUserId),
    expectedNickname: item.nickname,
    phase,
    addRoleIds: add.join(','),
    removeRoleIds: rem.join(','),
    needAddRoles: boolText(add.length > 0),
    needRemoveRoles: boolText(rem.length > 0),
    needNickname: boolText(nick),
  };
}

// Antes de começar uma pessoa: resultado excluído bloqueia; nota mudada
// desde a confirmação pede revisão.
async function revalidateBeforeStart(item) {
  if (item.startedAt || item.phase !== 'awaiting_precheck' || item.steps.some((s) => s.status === 'done')) return item;
  const a = await ExamAttempt.findById(item.attemptId).select('deletedAt revision').lean();
  let status = null;
  let reason = null;
  if (!a || a.deletedAt) { status = 'blocked'; reason = 'Resultado excluído antes do início da promoção.'; }
  else if (item.revisionAtConfirm != null && (a.revision || 0) !== item.revisionAtConfirm) { status = 'needs_review'; reason = 'A nota mudou depois da confirmação.'; }
  if (!status) return item;
  const update = { $set: { status, phase: 'done', reviewReason: reason, lastError: reason } };
  if (status === 'blocked') update.$unset = { lockKey: 1 };
  await Promotion.updateOne({ _id: item._id }, update);
  return Promotion.findById(item._id);
}

async function nextItem(jobId) {
  for (;;) {
    const item = await Promotion.findOne({ draftId: jobId, status: { $in: ['pending', 'in_progress'] } }).sort({ createdAt: 1, _id: 1 });
    if (!item) return null;
    const fresh = await revalidateBeforeStart(item);
    if (['pending', 'in_progress'].includes(fresh.status)) return fresh;
  }
}

async function claimJob(actor, jobId) {
  const job = await loadOwnedJob(actor, jobId);
  const now = new Date();
  let token;
  if (job.lease && job.lease.token && job.lease.until > now) {
    if (job.lease.holderDiscordId !== actor.actorDiscordId) throw new ApiError(409, 'job_locked', 'Outra execução deste lote está em andamento.');
    token = job.lease.token;
    await PromotionDraft.updateOne({ _id: job._id }, { $set: { 'lease.until': new Date(now.getTime() + JOB_LEASE_MS) } });
  } else {
    token = crypto.randomBytes(16).toString('hex');
    const got = await PromotionDraft.findOneAndUpdate(
      { _id: job._id, $or: [{ 'lease.token': null }, { 'lease.until': null }, { 'lease.until': { $lte: now } }] },
      { $set: { lease: { token, holderDiscordId: actor.actorDiscordId, until: new Date(now.getTime() + JOB_LEASE_MS) } } },
      { new: true },
    );
    if (!got) throw new ApiError(409, 'job_locked', 'Outra execução deste lote está em andamento.');
  }
  return jobPayload(actor, job._id, token);
}

async function jobSummary(jobId) {
  const items = await Promotion.find({ draftId: jobId }).sort({ createdAt: 1, _id: 1 }).lean();
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  const done = items.length > 0 && items.every((i) => TERMINAL.includes(i.status));
  const anns = await IntegrationNotification.find({ draftId: jobId, kind: 'promotion_announcement' }).sort({ createdAt: 1 }).select('status message').lean();
  const pendingAnn = anns.filter((n) => ['pending', 'dispatched'].includes(n.status));
  return { items, counts, done, anns, pendingAnn };
}

async function jobPayload(actor, jobId, leaseToken) {
  const item = await nextItem(jobId);
  const s = await jobSummary(jobId);
  if (s.done) await finishJob(actor, jobId);
  const after = s.done ? await jobSummary(jobId) : s;
  const base = {
    jobId: String(jobId),
    leaseToken: leaseToken || '',
    itemCount: String(after.items.length),
    remainingCount: String(after.items.filter((i) => ['pending', 'in_progress'].includes(i.status)).length),
    completedCount: String(after.counts.completed || 0),
    problemCount: String((after.counts.partial || 0) + (after.counts.failed || 0) + (after.counts.needs_review || 0) + (after.counts.blocked || 0)),
    jobDone: boolText(after.done),
    announcementPendingCount: String(after.pendingAnn.length),
    nextAnnouncementId: after.pendingAnn[0] ? String(after.pendingAnn[0]._id) : '',
    announcementsDelivered: String(after.anns.filter((n) => n.status === 'delivered').length),
    hasItem: boolText(Boolean(item)),
  };
  const empty = { itemId: '', memberDiscordId: '', memberMention: '', expectedNickname: '', phase: '', addRoleIds: '', removeRoleIds: '', needAddRoles: 'false', needRemoveRoles: 'false', needNickname: 'false' };
  for (let i = 1; i <= 5; i += 1) { empty[`addRole${i}`] = ''; empty[`removeRole${i}`] = ''; }
  const instr = item ? itemInstructions(item, item.phase === 'awaiting_result' ? 'act' : 'precheck') : empty;
  const msg = after.done ? await jobMessage(actor, after) : {};
  return { ...base, ...instr, displayText: jobText(after), ...msg };
}

function jobText(s) {
  return s.items.map((i) => `• ${mention(i.discordUserId)} \`${i.nickname}\` — ${i.status}${i.lastError ? ` (${truncate(i.lastError, 120)})` : ''}`).join('\n') || 'Nenhum item.';
}

async function jobMessage(actor, s) {
  const ok = s.items.filter((i) => i.status === 'completed');
  const problems = s.items.filter((i) => i.status !== 'completed');
  const listaMencoes = ok.map((i) => mention(i.discordUserId)).join('\n') || '—';
  if (!problems.length) {
    return renderForApi('promotion_completed', {
      ...baseContext(actor),
      'promocao.listaMencoes': listaMencoes,
      'promocao.listaApelidos': ok.map((i) => `${mention(i.discordUserId)} → ${userText(i.nickname, 40)}`).join('\n'),
      'promocao.total': String(ok.length),
      'promocao.cargoMencao': roleMention(actor.config.promotion.announceRoleId),
    });
  }
  return renderForApi('promotion_partial', {
    ...baseContext(actor),
    'promocao.listaMencoes': listaMencoes,
    'promocao.listaFalhas': problems.map((i) => `${mention(i.discordUserId)} — ${i.status}${i.lastError ? `: ${truncate(i.lastError, 150)}` : ''}`).join('\n'),
    'promocao.total': String(ok.length),
  });
}

async function assertLease(actor, jobId, leaseToken) {
  const job = await loadOwnedJob(actor, jobId);
  if (!job.lease || job.lease.token !== leaseToken || !job.lease.until || job.lease.until <= new Date() || job.lease.holderDiscordId !== actor.actorDiscordId) {
    throw new ApiError(409, 'lease_invalid', 'A reserva desta execução venceu ou não é sua. Chame claim de novo.');
  }
  await PromotionDraft.updateOne({ _id: job._id }, { $set: { 'lease.until': new Date(Date.now() + JOB_LEASE_MS) } });
  return job;
}

function parseRoleEvidence(value) {
  if (Array.isArray(value)) return value.map(String).filter((x) => isSnowflake(x));
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  if (text.includes('[object Object]')) return null;
  let parts = null;
  if (text.startsWith('[')) {
    try { parts = JSON.parse(text).map(String); } catch (_) { parts = null; }
  }
  if (!parts) parts = text.split(/[\s,;]+/);
  const ids = parts.map((x) => x.replace(/[^\d]/g, '')).filter(Boolean);
  if (ids.some((x) => !isSnowflake(x))) return null;
  return Array.from(new Set(ids));
}

// "add1=204, add2=204, rem1=204, nick=200" → { add1: 204, ... }
function parseStatusReport(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/\b(add[1-5]|rem[1-5]|nick)\s*[=:]\s*(\d{3})\b/g)) out[m[1]] = Number(m[2]);
  return out;
}

function statusFromSteps(steps) {
  if (steps.every((s) => s.status === 'done')) return 'completed';
  if (steps.some((s) => s.status === 'pending')) return 'in_progress';
  return steps.some((s) => s.status === 'done' && !s.alreadyInPlace) ? 'partial' : 'failed';
}

// Relato do executor. precheck: estado ANTES de mexer (reconcilia o que já
// está certo). result: estado DEPOIS — só marca "feito" o que o estado
// relatado confirma; o resto vira falha com o motivo.
async function progress(actor, jobId, body) {
  await assertLease(actor, jobId, body.leaseToken);
  const item = await Promotion.findOne({ draftId: jobId, discordUserId: body.memberDiscordId });
  if (!item) throw new ApiError(404, 'item_not_found', 'Esta pessoa não está neste lote.');
  if (!['pending', 'in_progress'].includes(item.status)) throw new ApiError(409, 'item_already_final', `Esta pessoa já está com status "${item.status}".`, { itemStatus: item.status });
  const now = new Date();
  // Status HTTP da leitura do membro (GET da API do Discord no BotGhost):
  // 404 = saiu do servidor; outro erro = leitura falhou, nada muda.
  const memberStatus = String(body.memberStatus || '').trim();
  if (memberStatus && memberStatus !== '200') {
    if (memberStatus === '404') body.memberFound = 'false';
    else throw new ApiError(422, 'member_read_failed', `A leitura do membro no Discord falhou (status ${truncate(memberStatus, 20)}). Nada foi alterado; tente de novo.`);
  }
  const statusMode = body.evidenceMode === 'status';

  if (body.memberFound === 'false') {
    item.steps.forEach((s) => { if (s.status === 'pending') { s.status = 'failed'; s.error = 'Membro não encontrado no servidor.'; s.at = now; } });
    item.lastError = 'Membro não encontrado no servidor.';
  } else if (statusMode) {
    // Modo "status": o BotGhost não conseguiu ler a lista de cargos, então
    // relata o status HTTP de cada pedido ao Discord. Adicionar/remover
    // cargo e mudar apelido são idempotentes no Discord (repetir não
    // estraga), por isso a pré-verificação aqui só libera a ação.
    if (body.phase === 'precheck') {
      if (item.phase !== 'awaiting_precheck') throw new ApiError(409, 'wrong_phase', 'Esta pessoa já passou da verificação inicial — relate o resultado (phase=result).');
      item.evidence.pre = { roleIds: [], nickname: null, at: now };
      item.status = 'in_progress';
      item.phase = 'awaiting_result';
      item.startedAt = item.startedAt || now;
    } else if (body.phase === 'result') {
      if (item.phase !== 'awaiting_result') throw new ApiError(409, 'wrong_phase', 'Relate primeiro a verificação inicial (phase=precheck).');
      const report = parseStatusReport(body.statusReport);
      const cfgAdd = item.steps.filter((st) => st.type === 'addRole').map((st) => st.roleId);
      const cfgRem = item.steps.filter((st) => st.type === 'removeRole').map((st) => st.roleId);
      item.steps.forEach((st) => {
        if (st.status !== 'pending') return;
        const key = st.type === 'addRole' ? `add${cfgAdd.indexOf(st.roleId) + 1}` : st.type === 'removeRole' ? `rem${cfgRem.indexOf(st.roleId) + 1}` : 'nick';
        const code = report[key];
        st.at = now;
        if (code >= 200 && code < 300) { st.status = 'done'; st.error = null; } else {
          st.status = 'failed';
          st.error = code ? `Discord recusou (HTTP ${code}).` : 'Status não relatado pelo BotGhost.';
        }
      });
      item.evidence.post = { roleIds: [], nickname: null, at: now };
      item.lastError = item.steps.filter((st) => st.status === 'failed').map((st) => st.error).join(' | ') || null;
    } else {
      throw new ApiError(400, 'invalid_field', 'phase deve ser "precheck" ou "result".');
    }
  } else {
    const roleIds = parseRoleEvidence(body.roleIds);
    if (roleIds === null) throw new ApiError(422, 'evidence_unreadable', 'roleIds não veio como lista de IDs (apareceu [object Object] ou texto inválido). Veja o guia: use a variável da lista de cargos do membro.');
    const nickname = String(body.nickname == null ? '' : body.nickname);
    const has = (id) => roleIds.includes(id);

    if (body.phase === 'precheck') {
      if (item.phase !== 'awaiting_precheck') throw new ApiError(409, 'wrong_phase', 'Esta pessoa já passou da verificação inicial — relate o resultado (phase=result).');
      item.evidence.pre = { roleIds, nickname, at: now };
      let external = true;
      item.steps.forEach((s) => {
        if (s.status !== 'pending') return;
        const inPlace = (s.type === 'addRole' && has(s.roleId)) || (s.type === 'removeRole' && !has(s.roleId)) || (s.type === 'setNickname' && nickname === s.nickname);
        if (inPlace) { s.status = 'done'; s.alreadyInPlace = true; s.at = now; } else if (s.type !== 'setNickname') external = false;
      });
      const roleSteps = item.steps.filter((s) => s.type !== 'setNickname');
      if (external && roleSteps.length && !item.startedAt) {
        // Já tinha os cargos antes da integração: exige decisão humana e
        // nunca entra em anúncio automático.
        item.status = 'needs_review';
        item.phase = 'done';
        item.preexisting = true;
        item.reviewReason = 'Já possui os cargos de promoção (atribuídos fora da integração). Confira o estado do membro; o admin pode aplicar só o apelido.';
        item.lastError = item.reviewReason;
      } else {
        item.status = statusFromSteps(item.steps) === 'completed' ? 'completed' : 'in_progress';
        item.phase = item.status === 'completed' ? 'done' : 'awaiting_result';
        item.startedAt = item.startedAt || now;
      }
    } else if (body.phase === 'result') {
      if (item.phase !== 'awaiting_result') throw new ApiError(409, 'wrong_phase', 'Relate primeiro a verificação inicial (phase=precheck).');
      item.evidence.post = { roleIds, nickname, at: now };
      const reported = String(body.actionError || '').slice(0, 300);
      item.steps.forEach((s) => {
        if (s.status !== 'pending') return;
        const ok = (s.type === 'addRole' && has(s.roleId)) || (s.type === 'removeRole' && !has(s.roleId)) || (s.type === 'setNickname' && nickname === s.nickname);
        s.at = now;
        if (ok) { s.status = 'done'; s.error = null; } else {
          s.status = 'failed';
          s.error = reported || (s.type === 'setNickname' ? 'Apelido não confirmado no membro.' : 'Cargo não confirmado no membro.');
        }
      });
      item.lastError = item.steps.filter((s) => s.status === 'failed').map((s) => s.error).join(' | ') || null;
    } else {
      throw new ApiError(400, 'invalid_field', 'phase deve ser "precheck" ou "result".');
    }
  }

  if (!['needs_review'].includes(item.status)) {
    const st = statusFromSteps(item.steps);
    if (st !== 'in_progress') {
      item.status = st;
      item.phase = 'done';
      if (st === 'completed') { item.completedAt = now; item.lastError = null; }
    }
  }
  // Resultado excluído depois de iniciada: registra o conflito (Mongo e
  // Discord não mudam juntos) e não anuncia essa pessoa.
  const attempt = await ExamAttempt.findById(item.attemptId).select('deletedAt').lean();
  if (item.startedAt && (!attempt || attempt.deletedAt)) item.conflict = 'Resultado excluído depois do início da promoção — confira e ajuste manualmente se necessário.';
  const update = { $set: item.toObject() };
  delete update.$set._id;
  if (item.status === 'failed' && !item.steps.some((s) => s.status === 'done' && !s.alreadyInPlace)) {
    delete update.$set.lockKey;
    update.$unset = { lockKey: 1 };
  }
  await Promotion.updateOne({ _id: item._id }, update);
  await logSecurityEvent('botghost_promotion_progress', {
    meta: { jobId: String(jobId), discordUserId: item.discordUserId, phase: body.phase, status: item.status, steps: item.steps.map((s) => `${s.type}:${s.status}`).join(',') },
  });
  const payload = await jobPayload(actor, jobId, body.leaseToken);
  return { itemStatus: item.status, itemError: item.lastError || '', ...payload };
}

// Lote terminado: anúncio SÓ de quem foi concluído (não os que já tinham os
// cargos, com conflito ou já anunciados), dividido em partes.
async function finishJob(actor, jobId) {
  const s = await jobSummary(jobId);
  if (!s.done) return;
  const allCompleted = s.items.every((i) => i.status === 'completed');
  await PromotionDraft.updateOne({ _id: jobId, status: { $in: ['executing', 'partial', 'completed'] } }, { $set: { status: allCompleted ? 'completed' : 'partial' } });
  const toAnnounce = s.items.filter((i) => i.status === 'completed' && !i.preexisting && !i.conflict && !i.announced && !i.announcementKey);
  if (!toAnnounce.length) return;
  const batch = (await IntegrationNotification.distinct('key', { draftId: jobId, kind: 'promotion_announcement' })).length + 1;
  const key = `announce:${jobId}:${batch}`;
  const reserved = await Promotion.updateMany({ _id: { $in: toAnnounce.map((i) => i._id) }, announcementKey: null }, { $set: { announcementKey: key } });
  if (!reserved.modifiedCount) return;
  const mine = await Promotion.find({ announcementKey: key }).sort({ createdAt: 1 }).lean();
  const config = actor.config;
  const chunks = chunkUserIds(mine.map((p) => p.discordUserId));
  for (const [index, userIds] of chunks.entries()) {
    const items = mine.filter((p) => userIds.includes(p.discordUserId));
    await notifications.createAnnouncement({
      draftId: jobId, batch, index, userIds,
      promotionIds: items.map((p) => p._id),
      nicknames: userIds.map((u) => (items.find((p) => p.discordUserId === u) || {}).nickname || ''),
      channelId: config.promotion.announceChannelId,
      roleId: config.promotion.announceRoleId,
    });
  }
}

async function getJob(actor, jobId) {
  await loadOwnedJob(actor, jobId);
  return jobPayload(actor, jobId, null);
}

// Retomada: só as etapas que falharam voltam para pendente, e a pessoa
// passa de novo pela verificação inicial (estado real do membro).
async function resumePromotion(promotionId, actorLabel) {
  const promo = await Promotion.findById(promotionId);
  if (!promo) throw new ApiError(404, 'item_not_found', 'Promoção não encontrada.');
  if (!['partial', 'failed'].includes(promo.status)) return { kind: 'nothing', promo };
  const set = {
    status: 'pending',
    phase: 'awaiting_precheck',
    lastError: null,
    steps: promo.steps.map((s) => { const o = s.toObject(); return o.status === 'failed' ? { ...o, status: 'pending', error: null } : o; }),
  };
  if (!promo.lockKey) set.lockKey = lockKeyFor(promo.guildId, promo.discordUserId);
  try {
    await Promotion.updateOne({ _id: promo._id, status: promo.status }, { $set: set, $inc: { retryCount: 1 } });
  } catch (err) {
    if (err && err.code === 11000) return { kind: 'locked', promo };
    throw err;
  }
  await PromotionDraft.updateOne({ _id: promo.draftId }, { $set: { status: 'executing' } });
  await logSecurityEvent('botghost_promotion_resumed', { meta: { promotionId: String(promo._id), discordUserId: promo.discordUserId, by: actorLabel } });
  return { kind: 'resumed', promo };
}

async function resumeJob(actor, jobId) {
  await loadOwnedJob(actor, jobId);
  const items = await Promotion.find({ draftId: jobId, status: { $in: ['partial', 'failed'] } }).select('_id');
  const out = [];
  for (const i of items) out.push(await resumePromotion(i._id, `discord:${actor.actorDiscordId}`));
  const payload = await jobPayload(actor, jobId, null);
  return { resumedCount: String(out.filter((o) => o.kind === 'resumed').length), lockedCount: String(out.filter((o) => o.kind === 'locked').length), ...payload };
}

async function cancelDraft(actor, draftId) {
  const draft = await loadOwnedDraft(actor, draftId, { editable: true });
  draft.status = 'cancelled';
  await draft.save();
  return { draftId: String(draft._id), draftStatus: 'cancelled' };
}

// ---------------- Admin ----------------

async function releasePromotion(promotionId, { actor, reason }) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw Object.assign(new Error('Informe o motivo (pelo menos 3 caracteres).'), { status: 400 });
  const promo = await Promotion.findOneAndUpdate(
    { _id: promotionId, lockKey: { $exists: true }, status: { $nin: ['pending', 'in_progress'] } },
    { $unset: { lockKey: 1 }, $set: { resolvedAdministratively: { by: actor, at: new Date(), reason: why.slice(0, 500) } } },
    { new: true },
  );
  if (!promo) throw Object.assign(new Error('Promoção não encontrada, já liberada ou ainda em execução.'), { status: 409 });
  await logSecurityEvent('botghost_promotion_released', { meta: { promotionId: String(promotionId), discordUserId: promo.discordUserId, by: actor, reason: why.slice(0, 500) } });
  return promo;
}

// "Já tinha os cargos": o admin decide aplicar só o que falta (apelido),
// sem anúncio. A pessoa volta para a verificação inicial.
async function acceptExternalState(promotionId, actorLabel) {
  const promo = await Promotion.findOneAndUpdate(
    { _id: promotionId, status: 'needs_review', preexisting: true },
    { $set: { status: 'pending', phase: 'awaiting_precheck', startedAt: new Date(), reviewReason: null, lastError: null } },
    { new: true },
  );
  if (!promo) throw Object.assign(new Error('Esta promoção não está aguardando essa revisão.'), { status: 409 });
  await PromotionDraft.updateOne({ _id: promo.draftId }, { $set: { status: 'executing' } });
  await logSecurityEvent('botghost_promotion_external_state_accepted', { meta: { promotionId: String(promotionId), by: actorLabel } });
  return promo;
}

module.exports = {
  getOrCreateDraft, loadOwnedDraft, listCandidates, candidateSlots, draftView, updateSelection, setMember, review, confirm,
  claimJob, progress, getJob, resumeJob, resumePromotion, cancelDraft, releasePromotion, acceptExternalState,
  parseRoleEvidence, parseStatusReport, statusFromSteps, lockKeyFor, JOB_LEASE_MS,
};
