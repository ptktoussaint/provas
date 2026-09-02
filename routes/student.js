const Room = require('../models/Room');
const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Settings = require('../models/Settings');

const { requireStudentSession } = require('../middleware/auth');
const { identifyLimiter, answerLimiter } = require('../middleware/rateLimit');
const { hashToken } = require('../lib/tokens');
const { toStudentAttemptView } = require('../lib/studentView');
const { startOrResumeAttempt, finalizeAttempt, isExpired } = require('../lib/examLifecycle');
const { logExamEvent } = require('../lib/eventLog');
const { logSecurityEvent } = require('../lib/securityLog');
const { buildIceServers } = require('../lib/turn');
const { extractYoutubeId } = require('../lib/youtube');
const liveState = require('../lib/liveState');
const { createSafeRouter } = require('../lib/safeRouter');

const router = createSafeRouter();

// Identificação: só o token da sala (do link) — requisito do usuário: o
// link já identifica o aluno de forma inequívoca (foi gerado pelo admin
// especificamente para ele), então não pede mais confirmação de nome antes
// de entrar.
router.post('/identify', identifyLimiter, async (req, res) => {
  const { studentToken } = req.body || {};
  if (!studentToken) {
    return res.status(400).json({ success: false, message: 'Link inválido.' });
  }

  const room = await Room.findOne({ studentTokenHash: hashToken(String(studentToken)) });
  if (!room || room.status === 'closed') {
    await logSecurityEvent('student_identify_invalid_token', { ip: req.ip });
    return res.status(404).json({ success: false, message: 'Link inválido ou sala encerrada.' });
  }

  const exam = await Exam.findById(room.examId);
  if (!exam || !exam.active) {
    return res.status(409).json({ success: false, message: 'Esta prova não está mais disponível.' });
  }

  const settings = await Settings.getOrCreate();

  req.session.student = { roomId: room._id.toString() };
  await new Promise((resolve) => req.session.save(resolve));

  res.json({
    success: true,
    room: { roomLabel: room.roomLabel, studentName: room.studentName, roomId: room._id.toString() },
    exam: {
      name: exam.name,
      imageUrl: exam.imageUrl,
      introVideoYoutubeId: extractYoutubeId(exam.introVideoYoutubeId || settings.introVideoYoutubeId),
      durationMinutes: exam.durationMinutes,
      questionCount: exam.questionCount,
    },
  });
});

router.use(requireStudentSession);

async function loadOwnRoom(req) {
  const room = await Room.findById(req.session.student.roomId);
  if (!room) throw Object.assign(new Error('Sala não encontrada.'), { status: 404 });
  return room;
}

router.get('/ice-servers', (req, res) => {
  res.json({ success: true, ...buildIceServers(`student:${req.session.student.roomId}`) });
});

// Cria (ou recupera) a tentativa. Chamado quando o aluno confirma que a
// transmissão de tela está ativa e válida (requisito #13/#18) — nunca antes.
router.post('/start', async (req, res) => {
  try {
    const room = await loadOwnRoom(req);
    const { attempt, resumed } = await startOrResumeAttempt(room._id);

    let current = attempt;
    if (isExpired(current) && current.status === 'in_progress') {
      current = await finalizeAttempt(current, 'timeout');
    }

    liveState.patch(room._id.toString(), {
      roomLabel: room.roomLabel,
      studentName: room.studentName,
      examId: room.examId.toString(),
      attemptId: current._id.toString(),
      attemptStatus: current.status,
      totalQuestions: current.snapshot.length,
      expiresAt: current.expiresAt,
    });

    // Sala com tentativa já finalizada (ex.: aluno recarregou a página
    // depois de terminar) — manda direto para a tela final, sem reabrir a
    // interface de prova (requisito #11: nunca reexibir nota/gabarito/UI de
    // resposta depois de finalizada).
    if (current.status !== 'in_progress') {
      return res.json({ success: true, finished: true });
    }

    res.json({ success: true, resumed, attempt: toStudentAttemptView(current), serverTime: Date.now() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/answer', answerLimiter, async (req, res) => {
  const { order, selectedKey } = req.body || {};
  if (!Number.isInteger(order) || !['A', 'B', 'C', 'D'].includes(selectedKey)) {
    return res.status(400).json({ success: false, message: 'Requisição inválida.' });
  }

  const room = await loadOwnRoom(req);
  if (!room.currentAttemptId) return res.status(409).json({ success: false, message: 'Nenhuma tentativa em andamento.' });

  let attempt = await ExamAttempt.findById(room.currentAttemptId);
  if (!attempt) return res.status(404).json({ success: false, message: 'Tentativa não encontrada.' });

  if (attempt.status !== 'in_progress') {
    return res.status(409).json({ success: false, message: 'Esta prova já foi finalizada.' });
  }
  if (isExpired(attempt)) {
    await finalizeAttempt(attempt, 'timeout');
    return res.status(409).json({ success: false, message: 'O tempo da prova acabou.' });
  }

  const question = attempt.snapshot.find((q) => q.order === order);
  if (!question) return res.status(404).json({ success: false, message: 'Questão não encontrada nesta tentativa.' });

  // Correção acontece aqui e somente aqui — nunca no frontend (requisitos
  // #10, #44). Update atômico via $ posicional em vez de save() completo:
  // evita que dois cliques quase simultâneos leiam-modifiquem-gravem o
  // documento inteiro e um pise no outro; e a condição status:'in_progress'
  // garante que não gravamos resposta numa tentativa finalizada entre a
  // leitura acima e este write (ex.: a varredura de expiração correu no meio).
  const isCorrect = selectedKey === question.correctKey;
  attempt = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress', 'snapshot.order': order },
    {
      $set: {
        'snapshot.$.selectedKey': selectedKey,
        'snapshot.$.isCorrect': isCorrect,
        'snapshot.$.answeredAt': new Date(),
        lastActivityAt: new Date(),
      },
    },
    { new: true },
  );
  if (!attempt) return res.status(409).json({ success: false, message: 'Esta prova já foi finalizada.' });

  const answeredCount = attempt.snapshot.filter((q) => q.selectedKey).length;
  liveState.patch(room._id.toString(), { currentQuestionOrder: order });

  req.app.get('io').to(`room:${room._id}`).emit('exam:progress', {
    currentQuestionOrder: order,
    answeredCount,
    totalQuestions: attempt.snapshot.length,
  });

  await logExamEvent({ roomId: room._id, attemptId: attempt._id, examId: attempt.examId, actor: 'student', type: 'answer_submitted', meta: { order } });

  res.json({ success: true, saved: true, answeredCount });
});

router.post('/finish', async (req, res) => {
  const room = await loadOwnRoom(req);
  if (!room.currentAttemptId) return res.status(409).json({ success: false, message: 'Nenhuma tentativa em andamento.' });

  let attempt = await ExamAttempt.findById(room.currentAttemptId);
  if (!attempt) return res.status(404).json({ success: false, message: 'Tentativa não encontrada.' });

  attempt = await finalizeAttempt(attempt, 'manual');
  liveState.patch(room._id.toString(), { attemptStatus: attempt.status });
  req.app.get('io').to(`room:${room._id}`).emit('attempt:finished', { reason: 'manual' });

  // Nunca revelar nota/gabarito/acertos ao aluno (requisito #11).
  res.json({ success: true, message: 'Prova finalizada com sucesso. Suas respostas foram registradas.' });
});

module.exports = router;
