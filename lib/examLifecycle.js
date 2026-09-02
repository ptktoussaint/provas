const Room = require('../models/Room');
const Question = require('../models/Question');
const ExamAttempt = require('../models/ExamAttempt');
const { pickRandomQuestions, buildSnapshot, gradeAttempt } = require('./grading');
const { logExamEvent } = require('./eventLog');

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

  const attempt = await ExamAttempt.create({
    roomId: room._id,
    examId: exam._id,
    studentName: room.studentName,
    startedAt,
    expiresAt,
    durationMinutes: exam.durationMinutes,
    pointsPerQuestion: exam.pointsPerQuestion,
    snapshot,
    unansweredCount: snapshot.length,
  });

  room.currentAttemptId = attempt._id;
  room.status = 'active';
  await room.save();

  await logExamEvent({ roomId: room._id, attemptId: attempt._id, examId: exam._id, actor: 'student', type: 'attempt_started' });

  return { attempt, resumed: false };
}

async function finalizeAttempt(attempt, reason = 'manual') {
  if (attempt.status !== 'in_progress') return attempt;

  const graded = gradeAttempt(attempt);
  attempt.score = graded.score;
  attempt.correctCount = graded.correctCount;
  attempt.wrongCount = graded.wrongCount;
  attempt.unansweredCount = graded.unansweredCount;
  attempt.status = reason === 'timeout' ? 'finished_timeout' : 'finished';
  attempt.finishedAt = new Date();
  await attempt.save();

  await Room.findByIdAndUpdate(attempt.roomId, { status: 'finished' });
  await logExamEvent({
    roomId: attempt.roomId,
    attemptId: attempt._id,
    examId: attempt.examId,
    actor: reason === 'timeout' ? 'system' : 'student',
    type: reason === 'timeout' ? 'attempt_finished_timeout' : 'attempt_finished',
  });

  return attempt;
}

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
