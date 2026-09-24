const ExamAttempt = require('../models/ExamAttempt');
const Promotion = require('../models/Promotion');
const PromotionDraft = require('../models/PromotionDraft');
const DiscordTask = require('../models/DiscordTask');
const { maxScoreOf, effectiveScore, isFinished } = require('../lib/results');
const { enqueue, saveProgress, safeErrorMessage } = require('../lib/outbox');
const { logSecurityEvent } = require('../lib/securityLog');
const { resultNotificationContent, resultMarker } = require('./format');
const { buildAnnouncementChunks, nonceFor } = require('./announce');
const { PermanentError, isPermanentError, discordCode } = require('./errors');

// Processadores das tarefas da fila. Recebem `ctx` com:
//   adapter    — operações no Discord (discord/adapter.js ou falso nos testes)
//   getConfig  — configuração atual (discord/configStore.js)
//   guildId    — servidor autorizado (DISCORD_GUILD_ID)
// Sempre releem o estado ATUAL do Mongo antes de agir.

const TERMINAL_PROMOTION = ['completed', 'partial', 'failed'];

// ---------------- Resultado (canal de resultados) ----------------

async function processResultSync(task, ctx) {
  const attempt = await ExamAttempt.findById(task.attemptId).select('-snapshot -auditTrail').populate('examId', 'name');
  if (!attempt) return { note: 'A tentativa não existe mais.' };

  const currentRevision = attempt.revision || 0;
  // Uma revisão mais nova já existe: ela (ou a reconciliação) cuida da
  // mensagem. Nunca publicar uma nota antiga por cima de uma mais nova.
  if ((task.revision || 0) < currentRevision) return { superseded: true, note: `Substituída pela revisão ${currentRevision}.` };
  const sync = attempt.discordSync || {};
  if ((sync.syncedRevision || 0) >= currentRevision) return { note: 'Já sincronizado.' };
  if (!attempt.discordUserId) {
    await markSynced(attempt, currentRevision, {});
    return { note: 'Sem vínculo com o Discord.' };
  }

  const deleted = Boolean(attempt.deletedAt);
  if (!deleted && !isFinished(attempt)) return { note: 'Tentativa ainda não finalizada.' };

  const content = resultNotificationContent({
    attemptId: attempt._id.toString(),
    discordUserId: attempt.discordUserId,
    score: effectiveScore(attempt),
    maxScore: maxScoreOf(attempt),
    examName: attempt.examId ? attempt.examId.name : '—',
    adjusted: attempt.adjustedScore != null,
    deleted,
  });
  // A menção aparece, mas ninguém é notificado (canal restrito da equipe).
  const payload = { content, allowedMentions: { parse: [] } };

  let messageRef = sync.messageId ? { channelId: sync.channelId, messageId: sync.messageId } : null;

  if (messageRef) {
    try {
      await ctx.adapter.editMessage(messageRef.channelId, messageRef.messageId, payload);
      await markSynced(attempt, currentRevision, messageRef);
      return { note: deleted ? 'Mensagem marcada como removida.' : 'Mensagem atualizada.' };
    } catch (err) {
      if (discordCode(err) === 10008) {
        messageRef = null; // apagaram a mensagem no Discord: segue como se não existisse
      } else if (isPermanentError(err)) {
        // Sem acesso/permissão: registra, mas o resultado continua correto no banco.
        await recordSyncError(attempt, `Não foi possível editar a mensagem de resultado: ${safeErrorMessage(err)}`);
        throw err;
      } else {
        throw err;
      }
    }
  }

  if (deleted) {
    await markSynced(attempt, currentRevision, {});
    return { note: 'Resultado excluído sem mensagem publicada — nada a fazer.' };
  }
  if (!sync.wantsMessage) {
    await markSynced(attempt, currentRevision, {});
    return { note: 'Resultado sem aviso de finalização pendente (vinculado depois pelo admin).' };
  }

  const config = await ctx.getConfig({ fresh: true });
  if (!config.resultsChannelId) throw new Error('CONFIG: canal de resultados não configurado na aba Discord.');
  const channelId = config.resultsChannelId;

  // Envio ambíguo (caiu entre o envio e a gravação do ID): procura a
  // mensagem já publicada antes de enviar de novo.
  const progress = task.progress || {};
  if (progress.sendStartedAt) {
    const found = await ctx.adapter.findRecentBotMessage(channelId, (text) => text.includes(resultMarker(attempt._id.toString())));
    if (found) {
      await ctx.adapter.editMessage(channelId, found.id, payload);
      await markSynced(attempt, currentRevision, { channelId, messageId: found.id });
      return { note: 'Mensagem já existente reaproveitada (envio anterior ambíguo).' };
    }
  }
  await saveProgress(task, { ...progress, sendStartedAt: new Date() });
  const sent = await ctx.adapter.sendMessage(channelId, { ...payload, nonce: nonceFor(task.key), enforceNonce: true });
  await markSynced(attempt, currentRevision, { channelId, messageId: sent.id });
  return { note: 'Mensagem de resultado publicada.' };
}

async function markSynced(attempt, revision, { channelId, messageId }) {
  if (messageId) {
    await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { 'discordSync.channelId': channelId, 'discordSync.messageId': messageId } });
  }
  // Condicional: se a revisão mudou durante o envio, a tarefa da revisão
  // nova ainda precisa rodar.
  await ExamAttempt.updateOne(
    { _id: attempt._id, revision },
    { $set: { 'discordSync.syncedRevision': revision, 'discordSync.lastError': null } },
  );
}

async function recordSyncError(attempt, message) {
  await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { 'discordSync.lastError': message, 'discordSync.lastErrorAt': new Date() } });
}

// ---------------- Promoção (cargos + apelido) ----------------

function reasonText(promo) {
  return `Promoção TCEL via bot (operador ${promo.operatorId})`;
}

async function saveStep(promo, index) {
  await Promotion.updateOne({ _id: promo._id }, { $set: { [`steps.${index}`]: promo.steps[index].toObject ? promo.steps[index].toObject() : promo.steps[index] } });
}

async function processPromotion(task, ctx) {
  const promo = await Promotion.findById(task.promotionId);
  if (!promo) return { note: 'Promoção não encontrada.' };
  if (!promo.steps.some((s) => s.status === 'pending')) {
    await afterPromotionTerminal(promo, ctx);
    return { note: 'Nada pendente.' };
  }

  if (promo.status !== 'in_progress') {
    promo.status = 'in_progress';
    await Promotion.updateOne({ _id: promo._id }, { $set: { status: 'in_progress' } });
  }

  const member = await ctx.adapter.fetchMember(promo.guildId, promo.discordUserId);
  if (!member) {
    await failRemainingSteps(promo, 'O membro não está mais no servidor.');
    return finishPromotion(promo, ctx);
  }

  for (let i = 0; i < promo.steps.length; i += 1) {
    const step = promo.steps[i];
    if (step.status !== 'pending') continue;

    // Reconciliação com o estado real: se já está como deveria, não chama
    // o Discord (retomada segura e sem efeito duplicado).
    let inPlace = false;
    if (step.type === 'addRole') inPlace = member.roleIds.includes(step.roleId);
    if (step.type === 'removeRole') inPlace = !member.roleIds.includes(step.roleId);
    if (step.type === 'setNickname') inPlace = member.nickname === step.nickname;

    try {
      if (!inPlace) {
        if (step.type === 'addRole') {
          await ctx.adapter.addRole(promo.guildId, promo.discordUserId, step.roleId, reasonText(promo));
          member.roleIds.push(step.roleId);
        } else if (step.type === 'removeRole') {
          await ctx.adapter.removeRole(promo.guildId, promo.discordUserId, step.roleId, reasonText(promo));
          member.roleIds = member.roleIds.filter((id) => id !== step.roleId);
        } else if (step.type === 'setNickname') {
          await ctx.adapter.setNickname(promo.guildId, promo.discordUserId, step.nickname, reasonText(promo));
          member.nickname = step.nickname;
        }
      }
      step.status = 'done';
      step.alreadyInPlace = inPlace;
      step.error = null;
      step.at = new Date();
      await saveStep(promo, i);
    } catch (err) {
      if (!isPermanentError(err)) throw err; // transitório: a fila repete só o que falta
      step.status = 'failed';
      step.error = safeErrorMessage(err);
      step.at = new Date();
      await saveStep(promo, i);
      promo.lastError = step.error;
      break; // não segue com as outras etapas depois de uma falha definitiva
    }
  }

  return finishPromotion(promo, ctx);
}

async function failRemainingSteps(promo, message) {
  promo.steps.forEach((s, i) => {
    if (s.status === 'pending') {
      promo.steps[i].status = 'failed';
      promo.steps[i].error = message;
      promo.steps[i].at = new Date();
    }
  });
  promo.lastError = message;
  await Promotion.updateOne({ _id: promo._id }, { $set: { steps: promo.steps, lastError: message } });
}

function promotionStatusFromSteps(steps) {
  if (steps.every((s) => s.status === 'done')) return 'completed';
  if (steps.some((s) => s.status === 'pending')) return 'in_progress';
  return steps.some((s) => s.status === 'done' && !s.alreadyInPlace) ? 'partial' : 'failed';
}

async function finishPromotion(promo, ctx) {
  const status = promotionStatusFromSteps(promo.steps);
  const set = { status, lastError: status === 'completed' ? null : promo.lastError };
  const update = { $set: set };
  if (status === 'completed') set.completedAt = new Date();
  // Falha total (nenhuma mudança real feita): libera o usuário para uma nova
  // tentativa. Parcial continua bloqueado até ser retomada ou resolvida.
  if (status === 'failed') update.$unset = { lockKey: 1 };
  await Promotion.updateOne({ _id: promo._id }, update);
  promo.status = status;

  await logSecurityEvent(`discord_promotion_${status}`, {
    meta: { promotionId: promo._id.toString(), discordUserId: promo.discordUserId, operatorId: promo.operatorId, error: set.lastError || null },
  });

  await afterPromotionTerminal(promo, ctx);
  return { note: `Promoção ${status}.` };
}

// Quando todas as promoções do lote terminam, fecha o rascunho e enfileira
// o anúncio SÓ dos concluídos (e ainda não anunciados). O anúncio é uma
// tarefa separada: se ele falhar, repete-se só o anúncio.
async function afterPromotionTerminal(promo, ctx) {
  const promos = await Promotion.find({ draftId: promo.draftId });
  if (promos.some((p) => !TERMINAL_PROMOTION.includes(p.status))) return;

  const allCompleted = promos.every((p) => p.status === 'completed');
  await PromotionDraft.updateOne({ _id: promo.draftId, status: { $in: ['executing', 'partial', 'completed'] } }, { $set: { status: allCompleted ? 'completed' : 'partial' } });

  await enqueueAnnouncementFor(promo.draftId, ctx);
}

async function enqueueAnnouncementFor(draftId, ctx) {
  const candidates = await Promotion.find({ draftId, status: 'completed', preexisting: false, announced: false, announceTaskKey: null }).select('_id');
  if (!candidates.length) return null;

  const seq = (await DiscordTask.countDocuments({ draftId, kind: 'promotion_announce' })) + 1;
  const key = `announce:${draftId}:${seq}`;
  await Promotion.updateMany({ _id: { $in: candidates.map((c) => c._id) }, announceTaskKey: null }, { $set: { announceTaskKey: key } });
  const reserved = await Promotion.find({ announceTaskKey: key }).select('_id discordUserId createdAt').sort({ createdAt: 1 });
  if (!reserved.length) return null;

  const config = await ctx.getConfig({ fresh: true });
  await enqueue({
    key,
    kind: 'promotion_announce',
    draftId,
    payload: {
      promotionIds: reserved.map((p) => p._id.toString()),
      userIds: reserved.map((p) => p.discordUserId),
      roleId: config.promotion.announceRoleId,
      channelId: config.promotion.announceChannelId,
    },
  });
  return key;
}

// ---------------- Anúncio ----------------

async function processAnnouncement(task, ctx) {
  const { userIds, roleId, channelId, promotionIds } = task.payload || {};
  if (!userIds || !userIds.length) return { note: 'Ninguém para anunciar.' };
  if (!channelId || !roleId) throw new PermanentError('Canal ou cargo do anúncio não definido.');

  const chunks = buildAnnouncementChunks({ roleId, userIds });
  const progress = { sent: {}, started: {}, ...(task.progress || {}) };

  for (let i = 0; i < chunks.length; i += 1) {
    if (progress.sent[i]) continue;
    const chunk = chunks[i];
    if (progress.started[i]) {
      const found = await ctx.adapter.findRecentBotMessage(channelId, (text) => text === chunk.content);
      if (found) {
        progress.sent[i] = found.id;
        await saveProgress(task, progress);
        continue;
      }
    }
    progress.started[i] = new Date().toISOString();
    await saveProgress(task, progress);
    const msg = await ctx.adapter.sendMessage(channelId, {
      content: chunk.content,
      allowedMentions: chunk.allowedMentions,
      nonce: nonceFor(task.key, i),
      enforceNonce: true,
    });
    progress.sent[i] = msg.id;
    await saveProgress(task, progress);
  }

  await Promotion.updateMany({ _id: { $in: promotionIds } }, { $set: { announced: true, announcedAt: new Date() } });
  await logSecurityEvent('discord_promotion_announced', { meta: { taskKey: task.key, count: userIds.length } });
  return { note: `Anúncio enviado (${chunks.length} mensagem(ns)).` };
}

// Chamado pelo worker quando uma tarefa esgota as tentativas: promoção não
// pode ficar "em andamento" para sempre.
async function onTaskFailed(task, err, ctx) {
  if (task.kind === 'promotion_execute' && task.promotionId) {
    const promo = await Promotion.findById(task.promotionId);
    if (!promo || TERMINAL_PROMOTION.includes(promo.status)) return;
    promo.lastError = safeErrorMessage(err);
    const anyChange = promo.steps.some((s) => s.status === 'done' && !s.alreadyInPlace);
    const status = anyChange ? 'partial' : 'failed';
    const update = { $set: { status, lastError: promo.lastError } };
    if (status === 'failed') update.$unset = { lockKey: 1 };
    await Promotion.updateOne({ _id: promo._id }, update);
    promo.status = status;
    await logSecurityEvent(`discord_promotion_${status}`, { meta: { promotionId: promo._id.toString(), discordUserId: promo.discordUserId, error: promo.lastError } });
    await afterPromotionTerminal(promo, ctx);
  }
  if (task.kind === 'result_sync' && task.attemptId) {
    await ExamAttempt.updateOne({ _id: task.attemptId }, { $set: { 'discordSync.lastError': safeErrorMessage(err), 'discordSync.lastErrorAt': new Date() } });
  }
}

const PROCESSORS = {
  result_sync: processResultSync,
  promotion_execute: processPromotion,
  promotion_announce: processAnnouncement,
};

module.exports = {
  PROCESSORS, processResultSync, processPromotion, processAnnouncement, onTaskFailed,
  afterPromotionTerminal, enqueueAnnouncementFor, promotionStatusFromSteps, TERMINAL_PROMOTION,
};
