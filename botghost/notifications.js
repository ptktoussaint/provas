const crypto = require('crypto');
const mongoose = require('mongoose');
const IntegrationNotification = require('../models/IntegrationNotification');
const ExamAttempt = require('../models/ExamAttempt');
const Promotion = require('../models/Promotion');
const { maxScoreOf, effectiveScore, writtenScore, isFinished } = require('../lib/results');
const { logSecurityEvent } = require('../lib/securityLog');
const { isSnowflake } = require('../lib/discordIds');
const configStore = require('./configStore');
const templates = require('./templates/store');
const { renderTemplate } = require('./templates/render');
const { sampleContext } = require('./templates/catalog');
const { userText, fmtNumber, fmtDateTime, mention, roleMention } = require('./format');
const { boolText } = require('./http');
const { startRoleActions, finishRoleActions, roleActionFields, isPerfectScore } = require('../lib/examGroups');

// Avisos que o bot do BotGhost publica em canais (resultado, anúncio,
// teste de modelo, atualização do painel). O site NUNCA fala direto com o
// Discord: ele avisa o BotGhost (webhook) e o BotGhost reserva a
// notificação aqui (claim), recebe o conteúdo ATUAL, publica/edita e
// confirma com o ID real da mensagem (ack).

const LEASE_MS = 2 * 60 * 1000;
// Devolução da Role base que esgotou as tentativas ("com falha"): a
// reconciliação só a recoloca na fila depois deste intervalo (o admin pode
// reprocessar antes pela aba Integração).
const RESTORE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const DISPATCH_CLAIM_TIMEOUT_MS = 3 * 60 * 1000;
const ANNOUNCE_FLOW_GRACE_MS = 2 * 60 * 1000;

function backoffMs(attempts) {
  return Math.min(30 * 60 * 1000, 20000 * 2 ** Math.max(0, attempts - 1));
}

function historyPush(event, detail = null) {
  return { $push: { history: { $each: [{ at: new Date(), event, detail: detail ? String(detail).slice(0, 300) : null }], $slice: -30 } } };
}

function safeError(err) {
  let msg = String((err && (err.message || err)) || 'erro desconhecido');
  msg = msg.replace(/\/(aluno|professor)\/[A-Za-z0-9_-]+/g, '/$1/[link]');
  msg = msg.replace(/Bearer\s+\S+/gi, 'Bearer [chave]');
  return msg.slice(0, 300);
}

function isDup(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

// ---------------- Criação ----------------

// Chamada a cada mudança do resultado (finalização, ajuste, exclusão,
// vínculo). NUNCA lança: a nota já está salva; o aviso é secundário.
// Uma notificação por tentativa, versionada: quem reserva recebe sempre o
// estado atual, e uma mudança durante a reserva agenda nova edição depois.
async function syncResultNotification(attempt) {
  try {
    if (!attempt || !attempt.discordUserId) return null;
    const key = `result:${attempt._id}`;
    const revision = attempt.revision || 0;
    const deleted = Boolean(attempt.deletedAt);
    // DAFP: a Role base volta por um aviso PRÓPRIO, que não depende da
    // mensagem de resultado (canal, modelo, exclusão) nem do resultado
    // acadêmico — só de a prova ter saído de "em andamento".
    await ensureBaseRoleRestore(attempt);
    const existing = await IntegrationNotification.findOne({ key });

    if (!existing) {
      if (deleted || !isFinished(attempt)) return null;
      if (!(attempt.discordSync && attempt.discordSync.wantsMessage)) return null;
      try {
        return await IntegrationNotification.create({ kind: 'result', key, attemptId: attempt._id, targetRevision: revision, history: [{ event: 'created' }] });
      } catch (err) {
        if (!isDup(err)) throw err;
        return syncResultNotification(attempt);
      }
    }

    const neverSent = !existing.message.messageId;
    const set = {};
    let extra = {};
    if (deleted && neverSent && ['pending', 'dispatched', 'failed'].includes(existing.status)) {
      // Excluído antes de ser publicado: nada deve aparecer no canal.
      set.status = 'cancelled';
      extra = historyPush('cancelled', 'resultado excluído antes da publicação');
    } else if (existing.status === 'claimed' || existing.status === 'ambiguous') {
      set.needsUpdate = true;
    } else if (existing.status === 'delivered' && revision > (existing.deliveredRevision || 0)) {
      Object.assign(set, { status: 'pending', nextDispatchAt: new Date(), dispatchAttempts: 0 });
      extra = historyPush('update_scheduled', `revisão ${revision}`);
    } else if (existing.status === 'failed') {
      Object.assign(set, { status: 'pending', nextDispatchAt: new Date(), dispatchAttempts: 0 });
      extra = historyPush('requeued', `revisão ${revision}`);
    }
    await IntegrationNotification.updateOne({ _id: existing._id }, { $max: { targetRevision: revision }, ...(Object.keys(set).length ? { $set: set } : {}), ...extra });
    return existing;
  } catch (err) {
    console.error('[botghost] falha ao agendar aviso de resultado (a nota continua salva):', safeError(err));
    return null;
  }
}

// Início real de uma prova DAFP: um aviso SEM mensagem, só para o BotGhost
// retirar a Role base do aluno. Chave única por tentativa (nunca dois).
// Nunca lança: a prova já começou e não depende do Discord.
function startKey(attemptId) {
  return `dafp_started:${attemptId}`;
}

async function createDafpStartNotification(attempt) {
  try {
    if (!attempt || !attempt.dafpBaseRoleRemovedId || !attempt.discordUserId) return null;
    const n = await IntegrationNotification.create({
      kind: 'dafp_started',
      key: startKey(attempt._id),
      attemptId: attempt._id,
      payload: { baseRoleId: attempt.dafpBaseRoleRemovedId, memberDiscordId: attempt.discordUserId },
      history: [{ event: 'created' }],
    });
    await ExamAttempt.updateOne({ _id: attempt._id, 'dafpBaseRole.removeRequestedAt': null }, { $set: { 'dafpBaseRole.removeRequestedAt': new Date() } });
    return n;
  } catch (err) {
    if (isDup(err)) return IntegrationNotification.findOne({ key: startKey(attempt._id) });
    console.error('[botghost] falha ao agendar a remoção da Role base (a prova continua):', safeError(err));
    return null;
  }
}

// A prova terminou antes de o BotGhost tirar a Role base: a remoção não é
// mais necessária (e, se viesse depois da devolução, deixaria o aluno sem
// a Role). Uma reserva em andamento não é cancelada — o fim espera por ela.
async function cancelPendingStart(attemptId) {
  await IntegrationNotification.updateOne(
    { key: startKey(attemptId), status: { $in: ['pending', 'dispatched', 'failed'] } },
    { $set: { status: 'cancelled', 'lease.token': null }, ...historyPush('cancelled', 'prova terminou antes da remoção da Role base') },
  );
}

// ---- Devolução da Role base (estado desejado) ----
// Fora de uma prova DAFP EFETIVAMENTE em andamento o aluno precisa TER a
// Role base. "Em andamento" = status in_progress e não excluída.
function restoreKey(attemptId) {
  return `dafp_restore:${attemptId}`;
}

function inProgress(attempt) {
  return attempt.status === 'in_progress' && !attempt.deletedAt;
}

// A tentativa teve a Role base retirada, já saiu de "em andamento" e a
// devolução ainda não foi confirmada pelo BotGhost.
function needsBaseRestore(attempt) {
  return Boolean(attempt && attempt.examGroup === 'DAFP' && attempt.dafpBaseRoleRemovedId && attempt.discordUserId
    && !inProgress(attempt) && !(attempt.dafpBaseRole && attempt.dafpBaseRole.restoreConfirmedAt));
}

// Outra prova DAFP do mesmo aluno em andamento: a Role base precisa
// continuar AUSENTE; a devolução fica para quando ela terminar.
function otherActiveDafpAttempt(attempt) {
  return ExamAttempt.exists({
    _id: { $ne: attempt._id },
    examGroup: 'DAFP',
    discordUserId: attempt.discordUserId,
    status: 'in_progress',
    deletedAt: null,
    dafpBaseRoleRemovedId: { $ne: null },
  });
}

// Ação oposta sobre a Role base do mesmo aluno que está com o BotGhost
// agora (reservada e não confirmada): a nova espera (409 not_ready).
function baseRoleInFlight(memberDiscordId, action, exceptId) {
  return IntegrationNotification.exists({
    _id: { $ne: exceptId },
    status: 'claimed',
    'lease.baseRoleAction': action,
    'lease.memberDiscordId': memberDiscordId,
    'lease.until': { $gt: new Date() },
  });
}

// Garante UM aviso de devolução na fila (dafp_restore:<tentativa>) para
// toda tentativa que saiu de "em andamento" sem devolução confirmada:
// cria, ou recoloca na fila se falhou/foi cancelado. Chamada em todo
// encerramento (finalizar, tempo, admin, exclusão) e pela reconciliação.
// Nunca lança. Devolve o aviso só quando criou/recolocou algo.
async function ensureBaseRoleRestore(attempt) {
  try {
    if (!needsBaseRestore(attempt)) return null;
    // A remoção do início que o BotGhost ainda nem pegou não serve mais (e,
    // se viesse depois da devolução, deixaria o aluno sem a Role).
    await cancelPendingStart(attempt._id);
    const now = new Date();
    await ExamAttempt.updateOne({ _id: attempt._id, 'dafpBaseRole.releasedAt': null }, { $set: { 'dafpBaseRole.releasedAt': now } });
    if (await otherActiveDafpAttempt(attempt)) return null;
    const key = restoreKey(attempt._id);
    let n = await IntegrationNotification.findOne({ key });
    let changed = false;
    if (!n) {
      try {
        n = await IntegrationNotification.create({
          kind: 'dafp_base_restore',
          key,
          attemptId: attempt._id,
          payload: { baseRoleId: attempt.dafpBaseRoleRemovedId, memberDiscordId: attempt.discordUserId },
          history: [{ event: 'created' }],
        });
        changed = true;
      } catch (err) {
        if (!isDup(err)) throw err;
        n = await IntegrationNotification.findOne({ key });
      }
    } else if (['failed', 'cancelled', 'delivered'].includes(n.status)) {
      // Sem confirmação registrada na tentativa: repetir o ADD é seguro
      // (adicionar quem já tem não muda nada) — melhor redundante do que o
      // aluno ficar sem a Role. "Com falha" (BotGhost não confirmou nas 6
      // tentativas) só volta depois de um intervalo: sem isso, um aviso que
      // o BotGhost nunca confirma seria disparado sem parar.
      const lastTry = new Date(n.lastErrorAt || n.updatedAt || 0).getTime();
      if (n.status === 'failed' && Date.now() - lastTry < RESTORE_RETRY_COOLDOWN_MS) return null;
      const r = await IntegrationNotification.updateOne(
        { _id: n._id, status: n.status },
        { $set: { status: 'pending', nextDispatchAt: now, dispatchAttempts: 0, needsUpdate: false, 'lease.token': null, 'lease.until': null }, ...historyPush('requeued', 'Role base ainda não devolvida') },
      );
      changed = r.modifiedCount > 0;
    }
    await ExamAttempt.updateOne({ _id: attempt._id, 'dafpBaseRole.restoreRequestedAt': null }, { $set: { 'dafpBaseRole.restoreRequestedAt': now } });
    return changed ? n : null;
  } catch (err) {
    console.error('[botghost] falha ao agendar a devolução da Role base (a prova continua encerrada):', safeError(err));
    return null;
  }
}

// Motivo para NÃO disparar agora o webhook de um aviso de cargo DAFP (o
// claim diria "nada a fazer" de qualquer jeito). Isolado pela tentativa do
// próprio aviso (attemptId): nunca olha a tentativa de outra sessão.
// - dafp_base_restore: a tentativa DELE ainda está em andamento, a Role já
//   foi devolvida, ou o aluno está fazendo outra prova DAFP (Role ausente);
// - dafp_started: a tentativa dele não está mais em andamento.
async function dispatchHoldReason(n) {
  if (!['dafp_base_restore', 'dafp_started'].includes(n.kind) || !n.attemptId) return null;
  const attempt = await ExamAttempt.findById(n.attemptId).select('status deletedAt discordUserId examGroup dafpBaseRoleRemovedId dafpBaseRole').lean();
  if (!attempt) return 'a tentativa não existe mais';
  if (n.kind === 'dafp_started') return inProgress(attempt) ? null : 'a prova já terminou: a Role base não precisa mais sair';
  if (inProgress(attempt)) return 'a tentativa deste aviso ainda está em andamento';
  if (attempt.dafpBaseRole && attempt.dafpBaseRole.restoreConfirmedAt) return 'a Role base desta tentativa já foi devolvida';
  if (await otherActiveDafpAttempt(attempt)) return 'o aluno está fazendo outra prova DAFP (Role base continua ausente)';
  return null;
}

async function createAnnouncement({ draftId, batch, index, userIds, promotionIds, nicknames, channelId, roleId }) {
  const key = `announce:${draftId}:${batch}:${index}`;
  try {
    return await IntegrationNotification.create({
      kind: 'promotion_announcement',
      key,
      draftId,
      chunkIndex: index,
      payload: { userIds, promotionIds: promotionIds.map(String), nicknames, channelId, roleId },
      // O próprio fluxo Promover costuma entregar na hora; o webhook é a
      // rede de segurança se o fluxo parar no meio.
      nextDispatchAt: new Date(Date.now() + ANNOUNCE_FLOW_GRACE_MS),
      history: [{ event: 'created' }],
    });
  } catch (err) {
    if (isDup(err)) return IntegrationNotification.findOne({ key });
    throw err;
  }
}

async function createTemplateTest(templateKey, actor) {
  const config = await configStore.getConfig({ fresh: true });
  if (!config.channels.test) throw Object.assign(new Error('Configure o canal de TESTE na aba Integração BotGhost antes de enviar um teste.'), { status: 409 });
  const n = await IntegrationNotification.create({
    kind: 'template_test',
    key: `test:${templateKey}:${crypto.randomBytes(6).toString('hex')}`,
    templateKey,
    payload: { requestedBy: actor },
    history: [{ event: 'created', detail: actor }],
  });
  await logSecurityEvent('template_test_requested', { meta: { templateKey, by: actor, notificationId: n._id.toString() } });
  return n;
}

async function createPanelUpdate(actor) {
  const config = await configStore.getConfig({ fresh: true });
  if (!config.panelMessage.messageId) throw Object.assign(new Error('Nenhum painel registrado ainda: use /provatcel no Discord uma vez para publicar e registrar o painel.'), { status: 409 });
  const open = await IntegrationNotification.findOne({ kind: 'panel_update', status: { $in: ['pending', 'dispatched', 'claimed'] } });
  if (open) return open;
  const n = await IntegrationNotification.create({ kind: 'panel_update', key: `panel:${Date.now()}`, payload: { requestedBy: actor }, history: [{ event: 'created', detail: actor }] });
  await logSecurityEvent('panel_update_requested', { meta: { by: actor } });
  return n;
}

// ---------------- Conteúdo (montado na hora da reserva) ----------------

function resultContext(attempt) {
  const finishedLabel = attempt.status === 'finished_timeout' ? 'tempo esgotado' : 'finalizada';
  return {
    ctx: {
      data: fmtDateTime(new Date()),
      'aluno.mencao': mention(attempt.discordUserId),
      'aluno.nome': userText(attempt.studentName, 80),
      'aluno.discordId': attempt.discordUserId,
      'prova.nome': userText(attempt.examId && attempt.examId.name ? attempt.examId.name : '—', 100),
      'resultado.nota': fmtNumber(effectiveScore(attempt)),
      'resultado.total': fmtNumber(maxScoreOf(attempt)),
      'resultado.notaOriginal': fmtNumber(attempt.score),
      'resultado.notaProva': fmtNumber(writtenScore(attempt)),
      'resultado.notaOral': fmtNumber(attempt.oralScore || 0),
      'resultado.notaFinal': fmtNumber(effectiveScore(attempt)),
      'resultado.situacao': finishedLabel,
      'resultado.tentativa': String(attempt._id).slice(-6),
      'resultado.data': fmtDateTime(attempt.finishedAt),
    },
    pingIds: { aluno: [attempt.discordUserId] },
  };
}

// Resultado DAFP: avaliador, aprovado/reprovado e cargo vêm do resultado
// gravado na finalização (attempt.outcome) — nunca recalculados aqui.
const DAFP_STATUS_TEXT = { APROVADO: 'APROVADO', REPROVADO: 'REPROVADO', NAO_APLICAVEL: 'Nota registrada' };

function dafpContext(attempt) {
  const base = resultContext(attempt);
  const o = attempt.outcome || {};
  const supId = attempt.supervisorDiscordId || '';
  return {
    ctx: {
      ...base.ctx,
      'prova.nome': userText(o.examName || (attempt.examId && attempt.examId.name) || '—', 100),
      'resultado.nota': fmtNumber(writtenScore(attempt)),
      'avaliador.mencao': supId ? mention(supId) : '—',
      'avaliador.nome': userText(attempt.supervisorDisplayName || '—', 80),
      'avaliador.discordId': supId,
      'resultado.status': DAFP_STATUS_TEXT[o.resultStatus] || 'Nota registrada',
      'resultado.notaMinima': o.autoApproval && o.passingScore != null ? fmtNumber(o.passingScore) : '',
      'resultado.cargoMencao': o.resultRoleId ? roleMention(o.resultRoleId) : '',
      'resultado.gabaritou': (o.perfectScore != null ? o.perfectScore : isPerfectScore(writtenScore(attempt), maxScoreOf(attempt))) ? 'Sim' : 'Não',
    },
    pingIds: { aluno: [attempt.discordUserId], avaliador: supId ? [supId] : [] },
  };
}

// Lote grande = várias mensagens: o cargo só notifica na primeira (as
// seguintes mostram a menção sem pingar de novo).
function announcementContext(payload, chunkIndex = 0) {
  const lines = payload.userIds.map((id) => mention(id));
  const nick = payload.userIds.map((id, i) => `${mention(id)} → ${userText(payload.nicknames ? payload.nicknames[i] : '', 40)}`);
  return {
    ctx: {
      data: fmtDateTime(new Date()),
      'promocao.cargoMencao': roleMention(payload.roleId),
      'promocao.listaMencoes': lines.join('\n'),
      'promocao.listaApelidos': nick.join('\n'),
      'promocao.total': String(payload.userIds.length),
    },
    pingIds: { promovidos: payload.userIds, cargoPromocao: chunkIndex ? [] : [payload.roleId] },
  };
}

class ClaimProblem extends Error {
  constructor(status, code, message, release = 'pending') {
    super(message);
    this.status = status;
    this.code = code;
    this.release = release;
  }
}

const EMPTY_SLOTS = [null, null, null];

async function buildClaimContent(n, config) {
  if (n.kind === 'dafp_started') {
    const attempt = await ExamAttempt.findById(n.attemptId).select('-snapshot -auditTrail -focusEvents -streamEvents').populate('examId', 'name slug');
    if (!attempt) throw new ClaimProblem(410, 'nothing_to_do', 'A tentativa não existe mais.', 'cancelled');
    if (!inProgress(attempt)) {
      throw new ClaimProblem(410, 'nothing_to_do', 'A prova já terminou: a Role base não precisa mais sair.', 'cancelled');
    }
    if (await baseRoleInFlight(attempt.discordUserId, 'ADD', n._id)) {
      throw new ClaimProblem(409, 'not_ready', 'Aguardando o BotGhost concluir a devolução da Role base de outra prova deste aluno.');
    }
    const fields = require('./dafpService').resultFields(attempt, { config });
    return { roleOnly: true, actionType: 'DAFP_STARTED', action: 'none', channelId: '', slots: startRoleActions(attempt), extra: fields, revision: null };
  }
  if (n.kind === 'dafp_base_restore') {
    // Devolução da Role base: sem mensagem, mesmo formato do fim
    // (DAFP_FINISHED, publishMessage "false", só a posição 1 = ADD).
    const attempt = await ExamAttempt.findById(n.attemptId).select('-snapshot -auditTrail -focusEvents -streamEvents').populate('examId', 'name slug');
    if (!attempt) throw new ClaimProblem(410, 'nothing_to_do', 'A tentativa não existe mais.', 'cancelled');
    if (inProgress(attempt)) throw new ClaimProblem(410, 'nothing_to_do', 'A prova ainda está em andamento.', 'cancelled');
    if (attempt.dafpBaseRole && attempt.dafpBaseRole.restoreConfirmedAt) {
      throw new ClaimProblem(410, 'nothing_to_do', 'A Role base desta prova já foi devolvida.', 'cancelled');
    }
    await cancelPendingStart(attempt._id);
    if (await otherActiveDafpAttempt(attempt)) {
      throw new ClaimProblem(410, 'nothing_to_do', 'O aluno está fazendo outra prova DAFP agora: a Role base volta quando ela terminar.', 'cancelled');
    }
    if (await baseRoleInFlight(attempt.discordUserId, 'REMOVE', n._id)) {
      throw new ClaimProblem(409, 'not_ready', 'Aguardando o BotGhost concluir a remoção da Role base do início da prova.');
    }
    const fields = require('./dafpService').resultFields(attempt, { config });
    // O mesmo membro/Role gravados quando a devolução foi pedida.
    const p = n.payload || {};
    const member = p.memberDiscordId || attempt.discordUserId;
    const slots = [{ action: 'ADD', roleId: p.baseRoleId || attempt.dafpBaseRoleRemovedId, memberDiscordId: member }, null, null];
    return { roleOnly: true, actionType: 'DAFP_FINISHED', action: 'none', channelId: '', slots, revision: null, extra: { ...fields, memberDiscordId: member } };
  }
  if (n.kind === 'result') {
    const attempt = await ExamAttempt.findById(n.attemptId).select('-snapshot -auditTrail -focusEvents -streamEvents').populate('examId', 'name slug');
    if (!attempt) throw new ClaimProblem(410, 'nothing_to_do', 'A tentativa não existe mais.', 'cancelled');
    const hasMessage = Boolean(n.message.messageId);
    const revision = attempt.revision || 0;
    if (attempt.examGroup === 'DAFP') return dafpResultContent(n, attempt, config, { hasMessage, revision });
    if (attempt.deletedAt) {
      if (!hasMessage) throw new ClaimProblem(410, 'nothing_to_do', 'Resultado excluído antes de ser publicado — nada a enviar.', 'cancelled');
      const { ctx, pingIds } = resultContext(attempt);
      return { templateKey: 'result_removed', action: 'edit', channelId: n.message.channelId, messageId: n.message.messageId, ctx, pingIds, revision };
    }
    if (!isFinished(attempt)) throw new ClaimProblem(409, 'not_ready', 'A prova ainda não foi finalizada.');
    const { ctx, pingIds } = resultContext(attempt);
    // Com prova oral lançada, a mensagem mostra a soma (antes ou depois de
    // já ter sido publicada).
    const templateKey = attempt.oralScore != null ? 'result_updated' : 'result_finished';
    if (hasMessage) {
      return { templateKey, action: 'edit', channelId: n.message.channelId, messageId: n.message.messageId, ctx, pingIds, revision };
    }
    if (!config.channels.results) throw new ClaimProblem(409, 'config_missing', 'Canal de resultados não configurado na aba Integração BotGhost.');
    return { templateKey, action: 'send', channelId: config.channels.results, ctx, pingIds, revision };
  }
  if (n.kind === 'promotion_announcement') {
    const { ctx, pingIds } = announcementContext(n.payload, n.chunkIndex || 0);
    return { templateKey: 'promotion_announcement', action: 'send', channelId: n.payload.channelId, ctx, pingIds, revision: null };
  }
  if (n.kind === 'template_test') {
    if (!config.channels.test) throw new ClaimProblem(409, 'config_missing', 'Canal de teste não configurado.');
    return { templateKey: n.templateKey, action: 'send', channelId: config.channels.test, ctx: sampleContext(n.templateKey), pingIds: {}, revision: null, test: true };
  }
  if (n.kind === 'panel_update') {
    if (!config.panelMessage.messageId) throw new ClaimProblem(410, 'nothing_to_do', 'Nenhum painel registrado.', 'cancelled');
    return { templateKey: 'panel', action: 'edit', channelId: config.panelMessage.channelId, messageId: config.panelMessage.messageId, ctx: { data: fmtDateTime(new Date()) }, pingIds: {}, revision: null, keepComponents: true };
  }
  throw new ClaimProblem(400, 'unknown_kind', 'Tipo de notificação desconhecido.', 'failed');
}

// Fim de uma prova DAFP (DAFP_FINISHED): mensagem de resultado + cargos.
// Cargos só até a PRIMEIRA entrega confirmada (edições depois não mexem em
// cargo). Ordem garantida: se a remoção do início ainda está com o BotGhost,
// espera; se nem começou, é cancelada (a devolução já cobre).
async function dafpResultContent(n, attempt, config, { hasMessage, revision }) {
  await cancelPendingStart(attempt._id);
  const firstDelivery = !n.message.deliveredAt;
  const fields = require('./dafpService').resultFields(attempt, { config, published: hasMessage });
  const o = attempt.outcome || {};
  const legacy = (slots) => {
    const approved = slots[1];
    return { applyRole: boolText(Boolean(approved)), roleId: approved ? approved.roleId : '', memberDiscordId: attempt.discordUserId || '' };
  };
  if (attempt.deletedAt) {
    if (hasMessage) {
      const { ctx, pingIds } = resultContext(attempt);
      return { templateKey: 'result_removed', action: 'edit', channelId: n.message.channelId, messageId: n.message.messageId, ctx, pingIds, revision, actionType: 'DAFP_FINISHED', slots: EMPTY_SLOTS, extra: { ...fields, ...legacy(EMPTY_SLOTS) } };
    }
    // Excluído antes de publicar: nada no canal. A Role base volta pelo
    // aviso próprio de devolução (dafp_base_restore).
    throw new ClaimProblem(410, 'nothing_to_do', 'Resultado excluído antes de ser publicado — nada a enviar.', 'cancelled');
  }
  if (!isFinished(attempt)) throw new ClaimProblem(409, 'not_ready', 'A prova ainda não foi finalizada.');
  const { ctx, pingIds } = dafpContext(attempt);
  const channelId = hasMessage ? n.message.channelId : (o.resultChannelId || config.dafp.resultChannelId);
  if (!channelId) throw new ClaimProblem(409, 'config_missing', 'Canal padrão de resultados DAFP não configurado na aba Integração BotGhost (nem canal próprio na prova).');
  const action = hasMessage ? 'edit' : 'send';
  const slots = firstDelivery ? finishRoleActions(attempt) : [...EMPTY_SLOTS];
  // Outra prova DAFP do aluno em andamento: a Role base fica AUSENTE.
  if (slots[0] && await otherActiveDafpAttempt(attempt)) slots[0] = null;
  // A devolução nunca passa na frente de uma remoção que está com o BotGhost.
  if (slots[0] && await baseRoleInFlight(attempt.discordUserId, 'REMOVE', n._id)) {
    throw new ClaimProblem(409, 'not_ready', 'Aguardando o BotGhost concluir a remoção da Role base do início da prova.');
  }
  return { templateKey: 'dafp_result', action, channelId, messageId: hasMessage ? n.message.messageId : undefined, ctx, pingIds, revision, actionType: 'DAFP_FINISHED', slots, extra: { ...fields, ...legacy(slots) } };
}

const ACTION_TYPES = { promotion_announcement: 'PROMOTION_ANNOUNCEMENT', template_test: 'TEMPLATE_TEST', panel_update: 'PANEL_UPDATE', result: 'TCEL_RESULT' };

function claimResponse(n, built, rendered, leaseToken, leaseUntil) {
  return {
    notificationId: String(n._id),
    kind: n.kind,
    leaseToken,
    leaseUntil: leaseUntil.toISOString(),
    action: built.action,
    channelId: built.channelId,
    messageId: built.messageId || '',
    keepComponents: built.keepComponents ? 'true' : 'false',
    renderedRevision: built.revision == null ? '' : String(built.revision),
    templateKey: built.templateKey || '',
    message: rendered.message,
    native: rendered.native,
    discordBodyJson: rendered.discordBodyJson,
    displayText: rendered.message.content || (rendered.message.embeds[0] && (rendered.message.embeds[0].title || rendered.message.embeds[0].description)) || '',
    // O que fazer (sempre presente): DAFP_STARTED | DAFP_FINISHED |
    // TCEL_RESULT | PROMOTION_ANNOUNCEMENT | TEMPLATE_TEST | PANEL_UPDATE.
    notificationActionType: built.actionType || ACTION_TYPES[n.kind] || n.kind,
    // "false" = não publicar nada (só executar os cargos e confirmar).
    publishMessage: boolText(!built.roleOnly),
    // Campos LEGADOS (mantidos por compatibilidade): cargo de aprovado.
    applyRole: 'false',
    roleId: '',
    memberDiscordId: '',
    ...(built.extra || {}),
    // Ações de cargo (DAFP): lista + campos fixos por posição (1..3).
    ...roleActionFields(built.slots || EMPTY_SLOTS),
    roleActionsPhase: (built.slots || []).some(Boolean) ? (built.actionType === 'DAFP_STARTED' ? 'START' : 'FINISH') : '',
  };
}

// Aviso só de cargos: nada para publicar.
const ROLE_ONLY_RENDER = { ok: true, message: { content: '', embeds: [], allowed_mentions: { parse: [], users: [], roles: [] } }, native: {}, discordBodyJson: '' };

// Reserva atômica: só UM executor recebe a notificação por vez (webhook e
// fluxo Promover podem tentar juntos — o segundo recebe "already_claimed").
async function claim(notificationId) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) return { status: 400, code: 'invalid_id', message: 'ID de notificação inválido.' };
  await expireLeases();
  const leaseToken = crypto.randomBytes(16).toString('hex');
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const n = await IntegrationNotification.findOneAndUpdate(
    { _id: notificationId, status: { $in: ['pending', 'dispatched'] } },
    { $set: { status: 'claimed', 'lease.token': leaseToken, 'lease.until': leaseUntil, 'lease.claimedAt': new Date(), needsUpdate: false }, $inc: { claimCount: 1 }, ...historyPush('claimed') },
    { new: true },
  );
  if (!n) {
    const cur = await IntegrationNotification.findById(notificationId).select('status message').lean();
    if (!cur) return { status: 404, code: 'not_found', message: 'Notificação não encontrada.' };
    const map = {
      delivered: [409, 'already_delivered', 'Esta notificação já foi entregue.'],
      claimed: [409, 'already_claimed', 'Outra execução já está cuidando desta notificação.'],
      ambiguous: [409, 'ambiguous_needs_review', 'Entrega ambígua: o admin precisa conferir o canal antes de qualquer reenvio.'],
      cancelled: [410, 'cancelled', 'Notificação cancelada (nada a publicar).'],
      failed: [409, 'failed', 'Notificação com falha — reprocesse pela aba Integração BotGhost.'],
    };
    const [status, code, message] = map[cur.status] || [409, 'unavailable', 'Notificação indisponível.'];
    return { status, code, message, data: { messageId: cur.message && cur.message.messageId ? cur.message.messageId : '' } };
  }

  const config = await configStore.getConfig({ fresh: true });
  try {
    const built = await buildClaimContent(n, config);
    let rendered = ROLE_ONLY_RENDER;
    if (!built.roleOnly) {
      const spec = await templates.getPublished(built.templateKey);
      rendered = renderTemplate(built.templateKey, spec, built.ctx, { mode: built.test ? 'test' : built.action, pingIds: built.pingIds });
      if (!rendered.ok) throw new ClaimProblem(422, 'render_failed', `O modelo "${built.templateKey}" não coube nos limites do Discord: ${rendered.errors.map((e) => e.message).join(' ')}`, 'failed');
    }
    const base = (built.slots || [])[0] || null;
    await IntegrationNotification.updateOne({ _id: n._id }, {
      $set: {
        'lease.action': built.action,
        'lease.renderedRevision': built.revision,
        'lease.channelId': built.channelId,
        'lease.baseRoleAction': base ? base.action : null,
        'lease.memberDiscordId': base ? base.memberDiscordId : null,
      },
    });
    return { status: 200, code: 'claimed', message: 'Notificação reservada.', data: claimResponse(n, built, rendered, leaseToken, leaseUntil) };
  } catch (err) {
    if (!(err instanceof ClaimProblem)) throw err;
    const set = { status: err.release, 'lease.token': null, 'lease.until': null, lastError: err.message, lastErrorAt: new Date() };
    if (err.release === 'pending') set.nextDispatchAt = new Date(Date.now() + backoffMs(n.dispatchAttempts || 1));
    await IntegrationNotification.updateOne({ _id: n._id }, { $set: set, ...historyPush(`claim_${err.code}`, err.message) });
    return { status: err.status, code: err.code, message: err.message };
  }
}

// Confirmação do BotGhost. Idempotente: repetir o mesmo ack não duplica
// nada. Um ack atrasado (reserva já vencida → "ambígua") com o mesmo
// token resolve a ambiguidade com o ID real da mensagem.
async function ack(notificationId, { leaseToken, outcome, messageId, channelId, error }) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) return { status: 400, code: 'invalid_id', message: 'ID de notificação inválido.' };
  const n = await IntegrationNotification.findById(notificationId);
  if (!n) return { status: 404, code: 'not_found', message: 'Notificação não encontrada.' };
  const token = String(leaseToken || '');

  if (outcome === 'delivered') {
    // Aviso só de cargos (início DAFP, resultado DAFP excluído antes de
    // publicar): não há mensagem, então não há messageId.
    const roleOnly = n.lease.action === 'none';
    const msgId = roleOnly ? (n.message.messageId || '') : String(messageId || n.message.messageId || '').trim();
    if (!roleOnly && !isSnowflake(msgId)) return { status: 400, code: 'invalid_message_id', message: 'Informe o ID real da mensagem (messageId).' };
    if (n.status === 'delivered' && (roleOnly ? n.lease.token === token : n.message.messageId === msgId)) {
      return { status: 200, code: 'already_acked', message: 'Confirmação já registrada.', data: { notificationId: String(n._id), messageId: msgId } };
    }
    if (!['claimed', 'ambiguous'].includes(n.status) || !token || n.lease.token !== token) {
      if (token) await lateRemoveGuard(n);
      return { status: 409, code: 'lease_mismatch', message: 'Esta reserva não é mais válida (venceu ou foi assumida por outra execução).' };
    }
    const ch = String(channelId || n.lease.channelId || n.message.channelId || '');
    const update = {
      $set: {
        status: 'delivered',
        'message.channelId': roleOnly ? n.message.channelId : (isSnowflake(ch) ? ch : n.lease.channelId),
        'message.messageId': msgId || null,
        'message.deliveredAt': new Date(),
        deliveredRevision: n.lease.renderedRevision,
        'lease.until': null,
        lastError: null,
      },
      ...historyPush(n.status === 'ambiguous' ? 'late_ack_resolved' : 'delivered', msgId || 'cargos executados'),
    };
    const done = await IntegrationNotification.findOneAndUpdate({ _id: n._id, 'lease.token': token, status: { $in: ['claimed', 'ambiguous'] } }, update, { new: true });
    if (!done) return { status: 409, code: 'lease_mismatch', message: 'Esta reserva não é mais válida.' };
    await afterDelivered(done);
    await configStore.recordStatus({ lastAckAt: new Date() }, { force: true });
    return { status: 200, code: 'acked', message: 'Entrega confirmada.', data: { notificationId: String(done._id), messageId: msgId, status: done.status } };
  }

  if (outcome === 'failed') {
    if (n.status !== 'claimed' || !token || n.lease.token !== token) {
      return { status: 409, code: 'lease_mismatch', message: 'Esta reserva não é mais válida.' };
    }
    const attempts = (n.dispatchAttempts || 0) + 1;
    const exhausted = attempts >= (n.maxDispatchAttempts || 6);
    await IntegrationNotification.updateOne({ _id: n._id, 'lease.token': token }, {
      $set: {
        status: exhausted ? 'failed' : 'pending',
        dispatchAttempts: attempts,
        nextDispatchAt: new Date(Date.now() + backoffMs(attempts)),
        'lease.token': null,
        'lease.until': null,
        lastError: safeError(error || 'falha relatada pelo BotGhost'),
        lastErrorAt: new Date(),
      },
      ...historyPush('failed_reported', error),
    });
    return { status: 200, code: exhausted ? 'failed' : 'will_retry', message: exhausted ? 'Falha registrada; tentativas esgotadas.' : 'Falha registrada; nova tentativa mais tarde.' };
  }
  return { status: 400, code: 'invalid_outcome', message: 'outcome deve ser "delivered" ou "failed".' };
}

// O BotGhost confirmou uma remoção da Role base com uma reserva que já não
// valia (venceu e a prova terminou nesse meio-tempo): a remoção pode ter
// acontecido DEPOIS da devolução. Se a prova não está mais em andamento,
// a devolução é pedida de novo (ADD repetido é seguro).
async function lateRemoveGuard(n) {
  if (n.kind !== 'dafp_started' || !n.attemptId) return;
  const attempt = await ExamAttempt.findById(n.attemptId).select('-snapshot -auditTrail -focusEvents -streamEvents');
  if (!attempt || inProgress(attempt)) return;
  await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { 'dafpBaseRole.restoreConfirmedAt': null, 'dafpBaseRole.restoreConfirmedVia': null } });
  attempt.dafpBaseRole.restoreConfirmedAt = null;
  await IntegrationNotification.updateOne({ _id: n._id }, historyPush('late_remove_ack', 'remoção confirmada fora da reserva: devolução pedida de novo'));
  await ensureBaseRoleRestore(attempt);
}

// A Role base do aluno acabou de ser confirmada como PRESENTE e ele não tem
// prova DAFP em andamento: devoluções pendentes de tentativas ANTERIORES
// dele (já encerradas, mesma Role) estão cumpridas — marcadas como
// devolvidas ("superseded") e seus avisos saem da fila. Sem isso, avisos
// antigos continuariam sendo disparados depois de o aluno já ter a Role.
async function supersedeOlderRestores(n) {
  const member = n.lease && n.lease.memberDiscordId;
  if (!member || !n.attemptId) return;
  const current = await ExamAttempt.findById(n.attemptId).select('dafpBaseRoleRemovedId').lean();
  const roleId = current && current.dafpBaseRoleRemovedId;
  if (!roleId) return;
  if (await ExamAttempt.exists({ examGroup: 'DAFP', discordUserId: member, status: 'in_progress', deletedAt: null, dafpBaseRoleRemovedId: { $ne: null } })) return;
  const older = await ExamAttempt.find({
    _id: { $ne: n.attemptId },
    examGroup: 'DAFP',
    discordUserId: member,
    dafpBaseRoleRemovedId: roleId,
    'dafpBaseRole.restoreConfirmedAt': null,
    $or: [{ status: { $ne: 'in_progress' } }, { deletedAt: { $ne: null } }],
  }).select('_id').lean();
  if (!older.length) return;
  const ids = older.map((a) => a._id);
  await ExamAttempt.updateMany({ _id: { $in: ids }, 'dafpBaseRole.restoreConfirmedAt': null }, { $set: { 'dafpBaseRole.restoreConfirmedAt': new Date(), 'dafpBaseRole.restoreConfirmedVia': 'superseded' } });
  await IntegrationNotification.updateMany(
    { key: { $in: ids.map((id) => restoreKey(id)) }, status: { $in: ['pending', 'dispatched', 'failed'] } },
    { $set: { status: 'cancelled' }, ...historyPush('cancelled', `Role base já devolvida por outro aviso (${n.kind} ${n._id})`) },
  );
}

async function afterDelivered(n, { byBot = true } = {}) {
  // Estado da Role base na tentativa: remoção/devolução confirmadas. Só o
  // ack do BotGhost confirma cargo — o admin marcando uma entrega ambígua
  // como publicada não prova que o cargo foi mexido (a devolução própria
  // continua valendo).
  const baseAction = byBot && n.lease && n.lease.baseRoleAction;
  if (baseAction && n.attemptId) {
    const field = baseAction === 'ADD' ? 'restoreConfirmedAt' : 'removeConfirmedAt';
    await ExamAttempt.updateOne(
      { _id: n.attemptId, [`dafpBaseRole.${field}`]: null },
      { $set: { [`dafpBaseRole.${field}`]: new Date(), ...(baseAction === 'ADD' ? { 'dafpBaseRole.restoreConfirmedVia': n.kind } : {}) } },
    );
    // Devolvida junto com o resultado: o aviso próprio que ainda nem saiu
    // não é mais necessário.
    if (baseAction === 'ADD' && n.kind !== 'dafp_base_restore') {
      await IntegrationNotification.updateOne(
        { key: restoreKey(n.attemptId), status: { $in: ['pending', 'dispatched', 'failed'] } },
        { $set: { status: 'cancelled' }, ...historyPush('cancelled', 'Role base já devolvida pelo aviso de resultado') },
      );
    }
    if (baseAction === 'ADD') await supersedeOlderRestores(n);
  }
  if (n.kind === 'result') {
    const attempt = await ExamAttempt.findById(n.attemptId).select('revision');
    await ExamAttempt.updateOne({ _id: n.attemptId }, {
      $set: { 'discordSync.channelId': n.message.channelId, 'discordSync.messageId': n.message.messageId, 'discordSync.syncedRevision': n.deliveredRevision || 0, 'discordSync.lastError': null },
    });
    // Mudou de novo enquanto estava reservada: agenda outra edição.
    if (attempt && (n.needsUpdate || (attempt.revision || 0) > (n.deliveredRevision || 0))) {
      await IntegrationNotification.updateOne({ _id: n._id, status: 'delivered' }, { $set: { status: 'pending', needsUpdate: false, nextDispatchAt: new Date(), dispatchAttempts: 0 }, ...historyPush('update_scheduled') });
    }
  }
  if (n.kind === 'promotion_announcement') {
    const ids = (n.payload.promotionIds || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    await Promotion.updateMany({ _id: { $in: ids } }, { $set: { announced: true, announcedAt: new Date(), announcementMessageId: n.message.messageId } });
  }
}

// Reserva vencida: EDIÇÃO pode ser refeita com segurança (edita a mesma
// mensagem); ENVIO vira "ambíguo" — a mensagem pode ter saído — e só o
// admin decide (conferir o canal e informar o ID, ou reenviar).
async function expireLeases(now = new Date()) {
  await IntegrationNotification.updateMany(
    { status: 'claimed', 'lease.until': { $lt: now }, 'lease.action': 'edit' },
    { $set: { status: 'pending', nextDispatchAt: now }, ...historyPush('lease_expired_retry') },
  );
  // Só cargos (action none, DAFP): refazer é seguro — adicionar/remover um
  // cargo de novo deixa o mesmo estado final. Mas cada reserva sem
  // confirmação CONTA como tentativa, com espera crescente: se o BotGhost
  // reserva e nunca confirma (ex.: ramo do evento não configurado), o aviso
  // esgota e fica "com falha", em vez de ser disparado a cada 2 minutos
  // para sempre.
  const roleOnly = await IntegrationNotification.find({ status: 'claimed', 'lease.until': { $lt: now }, 'lease.action': 'none' }).select('_id dispatchAttempts maxDispatchAttempts');
  for (const r of roleOnly) {
    const exhausted = (r.dispatchAttempts || 0) >= (r.maxDispatchAttempts || 6);
    await IntegrationNotification.updateOne({ _id: r._id, status: 'claimed', 'lease.until': { $lt: now } }, {
      $set: exhausted
        ? { status: 'failed', 'lease.token': null, lastError: 'O BotGhost reservou este aviso de cargo e nunca confirmou (ack). Confira no BotGhost o ramo DAFP_STARTED/DAFP_FINISHED do evento do webhook.', lastErrorAt: now }
        : { status: 'pending', nextDispatchAt: new Date(now.getTime() + backoffMs(r.dispatchAttempts || 1)), lastError: 'Reserva vencida sem confirmação do BotGhost (ack): nova tentativa.', lastErrorAt: now },
      ...historyPush(exhausted ? 'lease_expired_failed' : 'lease_expired_retry'),
    });
  }
  // Envio de mensagem: vira "ambíguo" (a mensagem pode ter saído).
  await IntegrationNotification.updateMany(
    { status: 'claimed', 'lease.until': { $lt: now }, 'lease.action': { $nin: ['edit', 'none'] } },
    { $set: { status: 'ambiguous', lastError: 'A reserva venceu sem confirmação: a mensagem pode ter sido publicada. Confira o canal.', lastErrorAt: now }, ...historyPush('lease_expired_ambiguous') },
  );
  // Webhook disparado mas nenhum evento veio reservar: volta para a fila.
  const stale = await IntegrationNotification.find({ status: 'dispatched', dispatchedAt: { $lt: new Date(now.getTime() - DISPATCH_CLAIM_TIMEOUT_MS) } }).select('_id dispatchAttempts maxDispatchAttempts');
  for (const s of stale) {
    const exhausted = s.dispatchAttempts >= (s.maxDispatchAttempts || 6);
    await IntegrationNotification.updateOne({ _id: s._id, status: 'dispatched' }, {
      $set: exhausted
        ? { status: 'failed', lastError: 'O webhook foi disparado, mas o evento do BotGhost nunca reservou a notificação. Confira o evento do webhook no BotGhost.', lastErrorAt: now }
        : { status: 'pending', nextDispatchAt: new Date(now.getTime() + backoffMs(s.dispatchAttempts)) },
      ...historyPush(exhausted ? 'never_claimed' : 'not_claimed_retry'),
    });
  }
}

// ---------------- Ações do admin ----------------

async function adminRetry(id, actor) {
  const n = await IntegrationNotification.findOneAndUpdate(
    { _id: id, status: { $in: ['failed', 'pending'] } },
    { $set: { status: 'pending', dispatchAttempts: 0, nextDispatchAt: new Date(), lastError: null }, ...historyPush('admin_retry', actor) },
    { new: true },
  );
  if (!n) throw Object.assign(new Error('Só notificações com falha ou pendentes podem ser reprocessadas.'), { status: 409 });
  await logSecurityEvent('integration_notification_retried', { meta: { id: String(id), by: actor } });
  return n;
}

async function adminResolveAmbiguous(id, { mode, messageId, channelId }, actor) {
  const n = await IntegrationNotification.findOne({ _id: id, status: 'ambiguous' });
  if (!n) throw Object.assign(new Error('Esta notificação não está em estado ambíguo.'), { status: 409 });
  if (mode === 'delivered') {
    if (!isSnowflake(String(messageId || ''))) throw Object.assign(new Error('Informe o ID da mensagem que já está no canal.'), { status: 400 });
    const done = await IntegrationNotification.findOneAndUpdate({ _id: id, status: 'ambiguous' }, {
      $set: { status: 'delivered', 'message.messageId': String(messageId), 'message.channelId': isSnowflake(String(channelId || '')) ? String(channelId) : n.lease.channelId, 'message.deliveredAt': new Date(), deliveredRevision: n.lease.renderedRevision, lastError: null },
      ...historyPush('admin_marked_delivered', actor),
    }, { new: true });
    await afterDelivered(done, { byBot: false });
  } else if (mode === 'resend') {
    await IntegrationNotification.updateOne({ _id: id, status: 'ambiguous' }, { $set: { status: 'pending', dispatchAttempts: 0, nextDispatchAt: new Date() }, ...historyPush('admin_resend', actor) });
  } else {
    throw Object.assign(new Error('Escolha "delivered" (já publicada) ou "resend" (reenviar).'), { status: 400 });
  }
  await logSecurityEvent('integration_notification_ambiguous_resolved', { meta: { id: String(id), mode, by: actor } });
}

module.exports = {
  announcementContext,
  syncResultNotification, createAnnouncement, createTemplateTest, createPanelUpdate, createDafpStartNotification, startKey,
  ensureBaseRoleRestore, restoreKey, dispatchHoldReason,
  claim, ack, expireLeases, adminRetry, adminResolveAmbiguous, backoffMs, safeError,
  LEASE_MS, DISPATCH_CLAIM_TIMEOUT_MS,
};
