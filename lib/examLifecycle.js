const Room = require('../models/Room');
const Question = require('../models/Question');
const ExamAttempt = require('../models/ExamAttempt');
const Exam = require('../models/Exam');
const { pickRandomQuestions, buildSnapshot, gradeAttempt } = require('./grading');
const { computeOutcome } = require('./examGroups');
const { logExamEvent } = require('./eventLog');
const liveState = require('./liveState');

function isExpired(attempt) {
  return Date.now() >= new Date(attempt.expiresAt).getTime();
}

// Cria a tentativa na primeira vez que o aluno inicia, ou devolve a
// existente se ele já estava em prova (refresh/reconexão nunca gera uma
// prova nova nem reinicia o cronômetro — requisitos #5, #55).
async function startOrResumeAttempt(roomId) {
  const room = await Room.findById(roomId).populate('examId');
  if (!room) throw Object.assign(new Error('Sala não encontrada.'), { status: 404 });
  const exam = room.examId;
  if (!exam || !exam.active) throw Object.assign(new Error('Esta prova não está mais disponível.'), { status: 409 });

  if (room.currentAttemptId) {
    const existing = await ExamAttempt.findById(room.currentAttemptId);
    if (existing) return { attempt: existing, resumed: true };
  }

  const activeQuestions = await Question.find({ examId: exam._id, active: true }).lean();
  if (activeQuestions.length === 0) {
    throw Object.assign(new Error('O banco de questões desta prova está vazio.'), { status: 409 });
  }

  const selected = pickRandomQuestions(activeQuestions, exam.questionCount);
  const snapshot = buildSnapshot(selected);
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + exam.durationMinutes * 60000);

  // Fiscais já conectados no momento em que a prova começa (chegaram antes
  // do aluno iniciar) — quem conectar depois é adicionado em
  // sockets/index.js (registerProctor). Sem isto, um fiscal que ficou
  // esperando desde antes do início nunca apareceria no histórico.
  const liveRoom = liveState.getRoom(room._id.toString());
  const proctorNames = [];
  if (liveRoom) {
    for (const info of liveRoom.proctors.values()) {
      if (info.isAdminMonitor) continue;
      if (info.label && !proctorNames.includes(info.label)) proctorNames.push(info.label);
    }
  }

  // DAFP: a Role base sai quando o aluno EFETIVAMENTE inicia (aqui), não na
  // criação da sala. Guardamos qual Role foi pedida para sair: a mesma
  // precisa voltar em qualquer encerramento definitivo.
  const examGroup = room.examGroup || exam.group || 'TCEL';
  let dafpBaseRoleRemovedId = null;
  if (examGroup === 'DAFP' && room.discordUserId) {
    const cfg = await require('../botghost/configStore').getConfig().catch(() => null);
    dafpBaseRoleRemovedId = (cfg && cfg.dafp && cfg.dafp.baseRoleId) || null;
  }

  const attempt = await ExamAttempt.create({
    roomId: room._id,
    examId: exam._id,
    studentName: room.studentName,
    roomLabel: room.roomLabel,
    proctorNames,
    startedAt,
    expiresAt,
    durationMinutes: exam.durationMinutes,
    pointsPerQuestion: exam.pointsPerQuestion,
    maxScore: snapshot.length * exam.pointsPerQuestion,
    snapshot,
    unansweredCount: snapshot.length,
    // Vínculo com o Discord copiado da sala pelo servidor (nunca vem do
    // aluno) — fica congelado na tentativa mesmo se a sala for excluída.
    discordGuildId: room.discordGuildId || null,
    discordUserId: room.discordUserId || null,
    supervisorDiscordId: (room.supervisor && room.supervisor.discordUserId) || null,
    supervisorDisplayName: (room.supervisor && room.supervisor.displayName) || null,
    studentAvatarUrl: room.studentAvatarUrl || null,
    examGroup,
    dafpBaseRoleRemovedId,
    dafpBaseRole: { suspendedAt: dafpBaseRoleRemovedId ? startedAt : null },
  });

  room.currentAttemptId = attempt._id;
  room.status = 'active';
  await room.save();

  await logExamEvent({ roomId: room._id, attemptId: attempt._id, examId: exam._id, actor: 'student', type: 'attempt_started' });

  // Uma notificação por tentativa (chave única): refresh/reconexão caem no
  // "resumed" acima e nunca chegam aqui. Nunca lança — falha no Discord não
  // bloqueia a prova.
  if (dafpBaseRoleRemovedId) {
    await require('../botghost/notifications').createDafpStartNotification(attempt);
    require('../botghost').kickDispatcher();
  }

  return { attempt, resumed: false };
}

// Finalização IDEMPOTENTE: a passagem in_progress → finalizada é uma
// escrita condicional única. Duas chamadas ao mesmo tempo (botão Finalizar
// + tempo esgotado + varredura + encerrar sala, refresh, reconexão) → só
// uma corrige, grava a nota e agenda o aviso; as outras só recebem a
// tentativa já finalizada, sem efeito nenhum. A nota e a aprovação são
// calculadas aqui, no servidor, a partir das respostas gravadas.
async function finalizeAttempt(attempt, reason = 'manual') {
  if (attempt.status !== 'in_progress') return attempt;
  // Relê do banco: corrige com as respostas realmente gravadas (o objeto
  // recebido pode ter sido lido antes da última resposta).
  const fresh = await ExamAttempt.findById(attempt._id);
  if (!fresh) return attempt;
  if (fresh.status !== 'in_progress') return fresh;

  const graded = gradeAttempt(fresh);
  const exam = await Exam.findById(fresh.examId).lean();
  const maxScore = fresh.maxScore != null ? fresh.maxScore : fresh.snapshot.length * (fresh.pointsPerQuestion || 0);
  const group = fresh.examGroup || (exam && exam.group) || 'TCEL';
  const dafp = group === 'DAFP' ? ((await require('../botghost/configStore').getConfig().catch(() => null)) || {}).dafp || null : null;
  const set = {
    score: graded.score,
    correctCount: graded.correctCount,
    wrongCount: graded.wrongCount,
    unansweredCount: graded.unansweredCount,
    status: reason === 'timeout' ? 'finished_timeout' : 'finished',
    finishedAt: new Date(),
    outcome: computeOutcome(exam, graded.score, maxScore, { reason, group, dafp, baseRoleRemovedId: fresh.dafpBaseRoleRemovedId }),
  };
  if (fresh.discordUserId) set['discordSync.wantsMessage'] = true;
  const finished = await ExamAttempt.findOneAndUpdate(
    { _id: fresh._id, status: 'in_progress' },
    { $set: set, $inc: { revision: 1 } },
    { new: true },
  );
  // Outra chamada finalizou no meio: devolve o que ela gravou, sem repetir
  // evento, aviso nem cálculo.
  if (!finished) return ExamAttempt.findById(fresh._id);

  await Room.findByIdAndUpdate(finished.roomId, { status: 'finished' });
  await logExamEvent({
    roomId: finished.roomId,
    attemptId: finished._id,
    examId: finished.examId,
    actor: FINALIZE_ACTORS[reason] || 'student',
    type: FINALIZE_EVENT_TYPES[reason] || 'attempt_finished',
  });

  // Aviso no Discord vai para a fila persistente (BotGhost) — a prova já
  // está salva e corrigida acima, com ou sem integração disponível. Nunca
  // lança; se falhar, a reconciliação periódica cria o aviso que faltou.
  await require('../botghost/notifications').syncResultNotification(finished);
  require('../botghost').kickDispatcher();

  return finished;
}

const FINALIZE_ACTORS = { manual: 'student', timeout: 'system', admin_closed: 'admin' };
const FINALIZE_EVENT_TYPES = {
  manual: 'attempt_finished',
  timeout: 'attempt_finished_timeout',
  admin_closed: 'attempt_finished_room_closed',
};

// Varredura periódica que garante o fim automático mesmo se o aluno fechar
// a aba ou perder a conexão perto do fim do tempo (requisito #9).
function startExpirySweep(io, intervalMs = 15000) {
  return setInterval(async () => {
    try {
      const expired = await ExamAttempt.find({ status: 'in_progress', expiresAt: { $lte: new Date() } });
      for (const attempt of expired) {
        await finalizeAttempt(attempt, 'timeout');
        io.to(`room:${attempt.roomId}`).emit('attempt:finished', { reason: 'timeout' });
      }
    } catch (err) {
      console.error('[expiry-sweep] erro:', err.message);
    }
  }, intervalMs);
}

module.exports = { startOrResumeAttempt, finalizeAttempt, isExpired, startExpirySweep };
