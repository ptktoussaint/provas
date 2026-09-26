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

// Avisos que o bot do BotGhost publica em canais (resultado, anúncio,
// teste de modelo, atualização do painel). O site NUNCA fala direto com o
// Discord: ele avisa o BotGhost (webhook) e o BotGhost reserva a
// notificação aqui (claim), recebe o conteúdo ATUAL, publica/edita e
// confirma com o ID real da mensagem (ack).

const LEASE_MS = 2 * 60 * 1000;
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

async function buildClaimContent(n, config) {
  if (n.kind === 'result') {
    const attempt = await ExamAttempt.findById(n.attemptId).select('-snapshot -auditTrail -focusEvents -streamEvents').populate('examId', 'name');
    if (!attempt) throw new ClaimProblem(410, 'nothing_to_do', 'A tentativa não existe mais.', 'cancelled');
    const hasMessage = Boolean(n.message.messageId);
    const revision = attempt.revision || 0;
    if (attempt.deletedAt) {
      if (!hasMessage) throw new ClaimProblem(410, 'nothing_to_do', 'Resultado excluído antes de ser publicado — nada a enviar.', 'cancelled');
      const { ctx, pingIds } = resultContext(attempt);
      return { templateKey: 'result_removed', action: 'edit', channelId: n.message.channelId, messageId: n.message.messageId, ctx, pingIds, revision };
    }
    if (!isFinished(attempt)) throw new ClaimProblem(409, 'not_ready', 'A prova ainda não foi finalizada.');
    if (attempt.examGroup === 'DAFP') {
      // DAFP: canal próprio (o da prova ou o padrão DAFP) e cargo do
      // resultado para o BotGhost aplicar — só no PRIMEIRO envio (edições
      // não reaplicam cargo).
      const { ctx, pingIds } = dafpContext(attempt);
      const o = attempt.outcome || {};
      const dafpFields = require('./dafpService').resultFields(attempt, { config, published: hasMessage });
      const channelId = hasMessage ? n.message.channelId : (o.resultChannelId || config.dafp.resultChannelId);
      if (!channelId) throw new ClaimProblem(409, 'config_missing', 'Canal padrão de resultados DAFP não configurado na aba Integração BotGhost (nem canal próprio na prova).');
      const action = hasMessage ? 'edit' : 'send';
      const extra = { ...dafpFields, applyRole: boolText(action === 'send' && Boolean(o.resultRoleId)), roleId: action === 'send' ? o.resultRoleId || '' : '', memberDiscordId: attempt.discordUserId };
      return { templateKey: 'dafp_result', action, channelId, messageId: hasMessage ? n.message.messageId : undefined, ctx, pingIds, revision, extra };
    }
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
    templateKey: built.templateKey,
    message: rendered.message,
    native: rendered.native,
    discordBodyJson: rendered.discordBodyJson,
    displayText: rendered.message.content || (rendered.message.embeds[0] && (rendered.message.embeds[0].title || rendered.message.embeds[0].description)) || '',
    // Fluxo DAFP: aplicar cargo? (sempre presente; "false" fora do DAFP).
    applyRole: 'false',
    roleId: '',
    memberDiscordId: '',
    ...(built.extra || {}),
  };
}

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
    const spec = await templates.getPublished(built.templateKey);
    const rendered = renderTemplate(built.templateKey, spec, built.ctx, { mode: built.test ? 'test' : built.action, pingIds: built.pingIds });
    if (!rendered.ok) throw new ClaimProblem(422, 'render_failed', `O modelo "${built.templateKey}" não coube nos limites do Discord: ${rendered.errors.map((e) => e.message).join(' ')}`, 'failed');
    await IntegrationNotification.updateOne({ _id: n._id }, {
      $set: { 'lease.action': built.action, 'lease.renderedRevision': built.revision, 'lease.channelId': built.channelId },
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
    const msgId = String(messageId || n.message.messageId || '').trim();
    if (!isSnowflake(msgId)) return { status: 400, code: 'invalid_message_id', message: 'Informe o ID real da mensagem (messageId).' };
    if (n.status === 'delivered' && n.message.messageId === msgId) {
      return { status: 200, code: 'already_acked', message: 'Confirmação já registrada.', data: { notificationId: String(n._id), messageId: msgId } };
    }
    if (!['claimed', 'ambiguous'].includes(n.status) || !token || n.lease.token !== token) {
      return { status: 409, code: 'lease_mismatch', message: 'Esta reserva não é mais válida (venceu ou foi assumida por outra execução).' };
    }
    const ch = String(channelId || n.lease.channelId || n.message.channelId || '');
    const update = {
      $set: {
        status: 'delivered',
        'message.channelId': isSnowflake(ch) ? ch : n.lease.channelId,
        'message.messageId': msgId,
        'message.deliveredAt': new Date(),
        deliveredRevision: n.lease.renderedRevision,
        'lease.until': null,
        lastError: null,
      },
      ...historyPush(n.status === 'ambiguous' ? 'late_ack_resolved' : 'delivered', msgId),
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

async function afterDelivered(n) {
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
    { $set: { status: 'pending', nextDispatchAt: now }, ...historyPush('lease_expired_retry_edit') },
  );
  await IntegrationNotification.updateMany(
    { status: 'claimed', 'lease.until': { $lt: now }, 'lease.action': { $ne: 'edit' } },
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
    await afterDelivered(done);
  } else if (mode === 'resend') {
    await IntegrationNotification.updateOne({ _id: id, status: 'ambiguous' }, { $set: { status: 'pending', dispatchAttempts: 0, nextDispatchAt: new Date() }, ...historyPush('admin_resend', actor) });
  } else {
    throw Object.assign(new Error('Escolha "delivered" (já publicada) ou "resend" (reenviar).'), { status: 400 });
  }
  await logSecurityEvent('integration_notification_ambiguous_resolved', { meta: { id: String(id), mode, by: actor } });
}

module.exports = {
  announcementContext,
  syncResultNotification, createAnnouncement, createTemplateTest, createPanelUpdate,
  claim, ack, expireLeases, adminRetry, adminResolveAmbiguous, backoffMs, safeError,
  LEASE_MS, DISPATCH_CLAIM_TIMEOUT_MS,
};
