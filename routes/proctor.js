const Room = require('../models/Room');
const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');

const { requireProctorSession } = require('../middleware/auth');
const { identifyLimiter } = require('../middleware/rateLimit');
const { hashToken, timingSafeEqualHex } = require('../lib/tokens');
const { buildIceServers } = require('../lib/turn');
const { logSecurityEvent } = require('../lib/securityLog');
const liveState = require('../lib/liveState');
const { createSafeRouter } = require('../lib/safeRouter');

const router = createSafeRouter();

// Descobrir o roomId não concede acesso à transmissão (requisito #53) — o
// acesso é sempre resolvido a partir do hash do token, nunca de um ID.
router.post('/identify', identifyLimiter, async (req, res) => {
  const { proctorToken } = req.body || {};
  if (!proctorToken) return res.status(400).json({ success: false, message: 'Link inválido.' });

  const hash = hashToken(String(proctorToken));
  const room = await Room.findOne({ proctorTokens: { $elemMatch: { tokenHash: hash, revokedAt: null } } });
  if (!room || room.status === 'closed') {
    await logSecurityEvent('proctor_identify_invalid_token', { ip: req.ip });
    return res.status(404).json({ success: false, message: 'Link inválido, revogado ou sala encerrada.' });
  }

  const tokenEntry = room.proctorTokens.find((t) => timingSafeEqualHex(t.tokenHash, hash));
  const exam = await Exam.findById(room.examId);

  // Ver comentário equivalente em routes/student.js: uma sessão só pode
  // representar um papel por vez, senão o servidor pode continuar
  // resolvendo essa conexão como um papel antigo (ex.: admin) e nunca
  // registrar de fato este fiscal.
  req.session.admin = null;
  req.session.student = null;
  req.session.proctor = { roomId: room._id.toString(), proctorTokenId: tokenEntry._id.toString() };
  await new Promise((resolve) => req.session.save(resolve));

  res.json({
    success: true,
    room: { roomLabel: room.roomLabel, studentName: room.studentName, roomId: room._id.toString() },
    exam: { name: exam ? exam.name : null },
  });
});

router.use(requireProctorSession);

router.get('/ice-servers', (req, res) => {
  res.json({ success: true, ...buildIceServers(`proctor:${req.session.proctor.proctorTokenId}`) });
});

router.get('/status', async (req, res) => {
  const { roomId } = req.session.proctor;
  const room = await Room.findById(roomId);
  if (!room || room.status === 'closed') {
    return res.status(410).json({ success: false, message: 'Esta sala foi encerrada.' });
  }

  let progress = null;
  if (room.currentAttemptId) {
    const attempt = await ExamAttempt.findById(room.currentAttemptId).select('status expiresAt startedAt snapshot').lean();
    if (attempt) {
      const answeredCount = attempt.snapshot.filter((q) => q.selectedKey).length;
      progress = {
        status: attempt.status,
        totalQuestions: attempt.snapshot.length,
        answeredCount,
        expiresAt: attempt.expiresAt,
      };
    }
  }

  res.json({
    success: true,
    room: { roomLabel: room.roomLabel, studentName: room.studentName },
    live: liveState.summary(roomId),
    progress,
    serverTime: Date.now(),
  });
});

module.exports = router;
