const argon2 = require('argon2');
const mongoose = require('mongoose');

const User = require('../models/User');
const Settings = require('../models/Settings');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const Room = require('../models/Room');
const ExamAttempt = require('../models/ExamAttempt');
const ExamEvent = require('../models/ExamEvent');
const SecurityLog = require('../models/SecurityLog');

const { requireAdmin } = require('../middleware/auth');
const { adminLoginLimiter, adminApiLimiter } = require('../middleware/rateLimit');
const { uploadImage } = require('../middleware/upload');
const { generateToken, hashToken } = require('../lib/tokens');
const { logSecurityEvent } = require('../lib/securityLog');
const { OPTION_KEYS, DEFAULT_THEME } = require('../lib/constants');
const { extractYoutubeId } = require('../lib/youtube');
const { parseQuestionsCsv, EXPECTED_COLUMNS } = require('../lib/csvImport');
const liveState = require('../lib/liveState');
const { createSafeRouter } = require('../lib/safeRouter');

const router = createSafeRouter();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ===================== Autenticação =====================

// Primeiro acesso: enquanto não existir NENHUM administrador cadastrado no
// banco, o próprio site oferece um formulário para criar o primeiro —
// evita depender de rodar scripts/seed-admin.js num terminal (requisito
// #56: facilidade de uso). Esse caminho se fecha sozinho para sempre assim
// que o primeiro admin é criado.
router.get('/setup-status', async (req, res) => {
  const count = await User.countDocuments();
  res.json({ success: true, needsSetup: count === 0 });
});

router.post('/setup-first-admin', adminLoginLimiter, async (req, res) => {
  const count = await User.countDocuments();
  if (count > 0) {
    return res.status(409).json({ success: false, message: 'Já existe um administrador configurado. Use a tela de login normal.' });
  }

  const { username, password } = req.body || {};
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'Escolha um nome de usuário.' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ success: false, message: 'A senha precisa ter pelo menos 8 caracteres.' });
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await User.create({ username: String(username).trim(), passwordHash, role: 'admin' });

  req.session.student = null;
  req.session.proctor = null;
  req.session.admin = { id: user._id.toString(), username: user.username };
  await logSecurityEvent('admin_setup_first_admin', { meta: { username: user.username }, ip: req.ip });
  res.status(201).json({ success: true, username: user.username });
});

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Usuário e senha são obrigatórios.' });
  }

  const user = await User.findOne({ username: String(username).trim() });
  const ip = req.ip;

  if (!user) {
    await logSecurityEvent('admin_login_failed', { meta: { username }, ip });
    return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
  }

  const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!valid) {
    await logSecurityEvent('admin_login_failed', { meta: { username }, ip });
    return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
  }

  req.session.student = null;
  req.session.proctor = null;
  req.session.admin = { id: user._id.toString(), username: user.username };
  await logSecurityEvent('admin_login_success', { meta: { username }, ip });
  res.json({ success: true, username: user.username });
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.admin = null;
  req.session.save(() => res.json({ success: true }));
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ success: true, admin: req.session.admin });
});

router.use(requireAdmin, adminApiLimiter);

// ===================== Configurações da plataforma =====================

router.get('/settings', async (req, res) => {
  const settings = await Settings.getOrCreate();
  res.json({ success: true, settings });
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const THEME_COLOR_FIELDS = ['primaryColorLight', 'primaryColor', 'primaryColorDark', 'backgroundColor', 'cardColor'];

router.put('/settings', async (req, res) => {
  const { platformName, introVideoYoutubeId, theme, resetTheme } = req.body || {};
  const settings = await Settings.getOrCreate();
  if (typeof platformName === 'string' && platformName.trim()) settings.platformName = platformName.trim();
  if (typeof introVideoYoutubeId === 'string') settings.introVideoYoutubeId = extractYoutubeId(introVideoYoutubeId);

  if (resetTheme) {
    settings.theme = { ...DEFAULT_THEME, backgroundImageUrl: settings.theme.backgroundImageUrl };
  } else if (theme && typeof theme === 'object') {
    for (const field of THEME_COLOR_FIELDS) {
      if (typeof theme[field] === 'string') {
        if (!HEX_COLOR_RE.test(theme[field])) {
          return res.status(400).json({ success: false, message: `Cor inválida em "${field}" — use um valor hexadecimal (#rrggbb).` });
        }
        settings.theme[field] = theme[field];
      }
    }
  }

  await settings.save();
  res.json({ success: true, settings });
});

router.post('/settings/logo', uploadImage.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada.' });
  const settings = await Settings.getOrCreate();
  settings.logoUrl = `/uploads/${req.file.filename}`;
  await settings.save();
  res.json({ success: true, settings });
});

router.post('/settings/background', uploadImage.single('background'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada.' });
  const settings = await Settings.getOrCreate();
  settings.theme.backgroundImageUrl = `/uploads/${req.file.filename}`;
  await settings.save();
  res.json({ success: true, settings });
});

router.delete('/settings/background', async (req, res) => {
  const settings = await Settings.getOrCreate();
  settings.theme.backgroundImageUrl = null;
  await settings.save();
  res.json({ success: true, settings });
});

// ===================== Provas =====================

router.get('/exams', async (req, res) => {
  const exams = await Exam.find().sort({ createdAt: -1 });
  res.json({ success: true, exams });
});

router.post('/exams', async (req, res) => {
  const { name, questionCount, pointsPerQuestion, durationMinutes, introVideoYoutubeId } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Nome da prova é obrigatório.' });
  }
  const exam = await Exam.create({
    name: String(name).trim(),
    questionCount: Number(questionCount) || 50,
    pointsPerQuestion: Number(pointsPerQuestion) || 2,
    durationMinutes: Number(durationMinutes) || 120,
    introVideoYoutubeId: extractYoutubeId(introVideoYoutubeId),
    createdBy: req.session.admin.id,
  });
  await logSecurityEvent('exam_created', { meta: { examId: exam._id.toString(), name: exam.name }, ip: req.ip });
  res.status(201).json({ success: true, exam });
});

router.put('/exams/:examId', async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });

  const allowed = ['name', 'questionCount', 'pointsPerQuestion', 'durationMinutes', 'introVideoYoutubeId', 'active'];
  const update = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      update[key] = req.body[key];
    }
  }
  if ('introVideoYoutubeId' in update) update.introVideoYoutubeId = extractYoutubeId(update.introVideoYoutubeId);

  const exam = await Exam.findByIdAndUpdate(examId, update, { new: true, runValidators: true });
  if (!exam) return res.status(404).json({ success: false, message: 'Prova não encontrada.' });
  await logSecurityEvent('exam_updated', { meta: { examId }, ip: req.ip });
  res.json({ success: true, exam });
});

router.post('/exams/:examId/image', uploadImage.single('image'), async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  if (!req.file) return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada.' });

  const exam = await Exam.findByIdAndUpdate(examId, { imageUrl: `/uploads/${req.file.filename}` }, { new: true });
  if (!exam) return res.status(404).json({ success: false, message: 'Prova não encontrada.' });
  res.json({ success: true, exam });
});

router.delete('/exams/:examId', async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });

  const roomCount = await Room.countDocuments({ examId });
  if (roomCount > 0) {
    return res.status(409).json({ success: false, message: 'Não é possível excluir: já existem salas associadas a esta prova. Desative-a em vez disso.' });
  }
  await Question.deleteMany({ examId });
  await Exam.findByIdAndDelete(examId);
  await logSecurityEvent('exam_deleted', { meta: { examId }, ip: req.ip });
  res.json({ success: true });
});

// ===================== Banco de questões =====================

router.get('/exams/:examId/questions', async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const questions = await Question.find({ examId }).sort({ createdAt: -1 });
  res.json({ success: true, questions });
});

function validateQuestionPayload(body) {
  const { text, options, correctKey } = body || {};
  if (!text || !String(text).trim()) return 'Texto da pergunta é obrigatório.';
  if (!Array.isArray(options) || options.length !== OPTION_KEYS.length) return `É necessário informar exatamente ${OPTION_KEYS.length} alternativas.`;
  const keys = options.map((o) => o.key);
  if (new Set(keys).size !== OPTION_KEYS.length || !OPTION_KEYS.every((k) => keys.includes(k))) {
    return `As alternativas devem ter as chaves ${OPTION_KEYS.join(', ')}.`;
  }
  if (options.some((o) => !o.text || !String(o.text).trim())) return 'Todas as alternativas precisam ter texto.';
  if (!OPTION_KEYS.includes(correctKey)) return 'Alternativa correta inválida.';
  return null;
}

router.post('/exams/:examId/questions', async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const exam = await Exam.findById(examId);
  if (!exam) return res.status(404).json({ success: false, message: 'Prova não encontrada.' });

  const error = validateQuestionPayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const { text, options, correctKey } = req.body;
  const question = await Question.create({
    examId,
    text: String(text).trim(),
    options: options.map((o) => ({ key: o.key, text: String(o.text).trim() })),
    correctKey,
  });
  res.status(201).json({ success: true, question });
});

// Modelo de CSV para o admin baixar e preencher (ou usar para conferir o
// que exportou do Google Forms/Sheets) — requisito #4.
router.get('/questions/import-template', (req, res) => {
  const header = EXPECTED_COLUMNS.join(',');
  const example = 'Qual é a capital do Brasil?,Rio de Janeiro,Brasília,São Paulo,Salvador,B';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-questoes.csv"');
  res.send(`${header}\n${example}\n`);
});

router.post('/exams/:examId/questions/import', async (req, res) => {
  const { examId } = req.params;
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const exam = await Exam.findById(examId);
  if (!exam) return res.status(404).json({ success: false, message: 'Prova não encontrada.' });

  const { csvText } = req.body || {};
  if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
    return res.status(400).json({ success: false, message: 'Envie o conteúdo do arquivo CSV.' });
  }

  const { questions, errors } = parseQuestionsCsv(csvText);
  if (questions.length === 0) {
    return res.status(400).json({ success: false, message: 'Nenhuma questão válida encontrada no arquivo.', errors });
  }

  const docs = questions.map((q) => ({ examId, text: q.text, options: q.options, correctKey: q.correctKey }));
  const inserted = await Question.insertMany(docs, { ordered: false });

  await logSecurityEvent('questions_imported', { meta: { examId, count: inserted.length, errorCount: errors.length }, ip: req.ip });
  res.status(201).json({ success: true, imported: inserted.length, errors });
});

router.put('/questions/:questionId', async (req, res) => {
  const { questionId } = req.params;
  if (!isValidObjectId(questionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });

  const error = validateQuestionPayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const { text, options, correctKey } = req.body;
  const question = await Question.findByIdAndUpdate(
    questionId,
    { text: String(text).trim(), options: options.map((o) => ({ key: o.key, text: String(o.text).trim() })), correctKey },
    { new: true, runValidators: true },
  );
  if (!question) return res.status(404).json({ success: false, message: 'Questão não encontrada.' });
  await logSecurityEvent('question_updated', { meta: { questionId }, ip: req.ip });
  res.json({ success: true, question });
});

router.patch('/questions/:questionId/active', async (req, res) => {
  const { questionId } = req.params;
  if (!isValidObjectId(questionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const { active } = req.body || {};
  const question = await Question.findByIdAndUpdate(questionId, { active: Boolean(active) }, { new: true });
  if (!question) return res.status(404).json({ success: false, message: 'Questão não encontrada.' });
  res.json({ success: true, question });
});

router.post('/questions/:questionId/duplicate', async (req, res) => {
  const { questionId } = req.params;
  if (!isValidObjectId(questionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const original = await Question.findById(questionId).lean();
  if (!original) return res.status(404).json({ success: false, message: 'Questão não encontrada.' });

  const { _id, createdAt, updatedAt, __v, ...rest } = original;
  const copy = await Question.create({ ...rest, text: `${rest.text} (cópia)` });
  res.status(201).json({ success: true, question: copy });
});

router.delete('/questions/:questionId', async (req, res) => {
  const { questionId } = req.params;
  if (!isValidObjectId(questionId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  await Question.findByIdAndDelete(questionId);
  await logSecurityEvent('question_deleted', { meta: { questionId }, ip: req.ip });
  res.json({ success: true });
});

// ===================== Salas =====================

router.get('/rooms', async (req, res) => {
  const rooms = await Room.find().populate('examId', 'name').sort({ createdAt: -1 }).lean();
  const withLive = rooms.map((room) => ({
    ...room,
    proctorTokens: room.proctorTokens.map((t) => ({ _id: t._id, label: t.label, revokedAt: t.revokedAt, createdAt: t.createdAt })),
    live: liveState.summary(room._id.toString()),
  }));
  res.json({ success: true, rooms: withLive });
});

router.post('/rooms', async (req, res) => {
  const { examId, roomLabel, studentName } = req.body || {};
  if (!isValidObjectId(examId)) return res.status(400).json({ success: false, message: 'Prova inválida.' });
  if (!roomLabel || !String(roomLabel).trim()) return res.status(400).json({ success: false, message: 'Identificação da sala é obrigatória.' });
  if (!studentName || !String(studentName).trim()) return res.status(400).json({ success: false, message: 'Nome do aluno é obrigatório.' });

  const exam = await Exam.findById(examId);
  if (!exam) return res.status(404).json({ success: false, message: 'Prova não encontrada.' });

  const rawToken = generateToken();
  const room = await Room.create({
    examId,
    roomLabel: String(roomLabel).trim(),
    studentName: String(studentName).trim(),
    studentTokenHash: hashToken(rawToken),
    createdBy: req.session.admin.id,
  });

  res.status(201).json({
    success: true,
    room,
    studentLink: `/aluno/${rawToken}`,
  });
});

// O link do aluno só é mostrado uma vez na criação (só o hash fica salvo —
// nunca o token em texto puro, mesmo princípio de senha). Se o admin
// perdeu o link, a única forma seguridade de recuperar o acesso é emitir
// um token novo, invalidando o antigo. Isso NÃO desconecta um aluno que já
// estava em prova: a sessão dele já guarda o roomId, não o token.
router.post('/rooms/:roomId/regenerate-student-link', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidObjectId(roomId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ success: false, message: 'Sala não encontrada.' });

  const rawToken = generateToken();
  room.studentTokenHash = hashToken(rawToken);
  await room.save();
  await logSecurityEvent('student_link_regenerated_by_admin', { meta: { roomId }, ip: req.ip });

  res.json({ success: true, studentLink: `/aluno/${rawToken}` });
});

router.post('/rooms/:roomId/proctor-tokens', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidObjectId(roomId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ success: false, message: 'Sala não encontrada.' });

  const { label } = req.body || {};
  const rawToken = generateToken();
  room.proctorTokens.push({ label: label ? String(label).trim() : 'Fiscal', tokenHash: hashToken(rawToken) });
  await room.save();

  res.status(201).json({
    success: true,
    proctorLink: `/professor/${rawToken}`,
    tokenId: room.proctorTokens[room.proctorTokens.length - 1]._id,
  });
});

router.delete('/rooms/:roomId/proctor-tokens/:tokenId', async (req, res) => {
  const { roomId, tokenId } = req.params;
  if (!isValidObjectId(roomId) || !isValidObjectId(tokenId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ success: false, message: 'Sala não encontrada.' });

  const token = room.proctorTokens.id(tokenId);
  if (!token) return res.status(404).json({ success: false, message: 'Token não encontrado.' });
  token.revokedAt = new Date();
  await room.save();
  res.json({ success: true });
});

router.post('/rooms/:roomId/close', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidObjectId(roomId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ success: false, message: 'Sala não encontrada.' });

  room.status = 'closed';
  await room.save();

  if (room.currentAttemptId) {
    await ExamAttempt.findOneAndUpdate(
      { _id: room.currentAttemptId, status: 'in_progress' },
      { status: 'finished', finishedAt: new Date() },
    );
  }

  req.app.get('io').to(`room:${roomId}`).emit('room:closed');
  liveState.removeRoom(roomId);
  await logSecurityEvent('room_closed_by_admin', { meta: { roomId }, ip: req.ip });
  res.json({ success: true });
});

// Exclusão definitiva — some da lista junto com o histórico daquela sala
// (tentativa e eventos de auditoria). Só permitida com a sala já encerrada
// (nunca com um aluno em prova) para não apagar dados de algo em andamento.
router.delete('/rooms/:roomId', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidObjectId(roomId)) return res.status(400).json({ success: false, message: 'ID inválido.' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ success: false, message: 'Sala não encontrada.' });

  if (room.status === 'active') {
    return res.status(409).json({ success: false, message: 'Encerre a sala antes de excluí-la.' });
  }

  await ExamAttempt.deleteMany({ roomId });
  await ExamEvent.deleteMany({ roomId });
  await Room.findByIdAndDelete(roomId);
  liveState.removeRoom(roomId);
  await logSecurityEvent('room_deleted_by_admin', { meta: { roomId }, ip: req.ip });
  res.json({ success: true });
});

// ===================== Dashboard / salas ao vivo =====================

router.get('/dashboard', async (req, res) => {
  const [examsInProgress, examsFinished, roomsActive] = await Promise.all([
    ExamAttempt.countDocuments({ status: 'in_progress' }),
    ExamAttempt.countDocuments({ status: { $in: ['finished', 'finished_timeout'] } }),
    Room.countDocuments({ status: 'active' }),
  ]);

  const liveSummaries = liveState.allSummaries();
  const studentsOnline = liveSummaries.filter((r) => r.studentOnline).length;
  const proctorsConnected = liveSummaries.reduce((acc, r) => acc + r.proctorCount, 0);
  const transmissionsLive = liveSummaries.filter((r) => r.streamStatus === 'live').length;
  const focusAlerts = liveSummaries.filter((r) => r.focusStatus === 'out').length;

  res.json({
    success: true,
    dashboard: {
      examsInProgress,
      examsFinished,
      roomsActive,
      studentsOnline,
      proctorsConnected,
      transmissionsLive,
      focusAlerts,
    },
  });
});

router.get('/rooms/live', (req, res) => {
  res.json({ success: true, rooms: liveState.allSummaries() });
});

// ===================== Resultados e auditoria =====================

router.get('/results', async (req, res) => {
  const { examId, status } = req.query;
  const filter = {};
  if (examId && isValidObjectId(examId)) filter.examId = examId;
  if (status) filter.status = status;

  const attempts = await ExamAttempt.find(filter)
    .select('-snapshot')
    .populate('roomId', 'roomLabel studentName')
    .populate('examId', 'name')
    .sort({ createdAt: -1 })
    .lean();

  res.json({ success: true, attempts });
});

router.get('/results/:attemptId', async (req, res) => {
  const { attemptId } = req.params;
  if (!isValidObjectId(attemptId)) return res.status(400).json({ success: false, message: 'ID inválido.' });

  const attempt = await ExamAttempt.findById(attemptId)
    .populate('roomId', 'roomLabel studentName')
    .populate('examId', 'name')
    .lean();
  if (!attempt) return res.status(404).json({ success: false, message: 'Tentativa não encontrada.' });

  const { filter } = req.query;
  let questions = attempt.snapshot;
  if (filter === 'correct') questions = questions.filter((q) => q.isCorrect === true);
  if (filter === 'wrong') questions = questions.filter((q) => q.isCorrect === false);
  if (filter === 'unanswered') questions = questions.filter((q) => !q.selectedKey);

  res.json({
    success: true,
    attempt: { ...attempt, snapshot: undefined },
    questions: questions.map((q) => ({
      order: q.order,
      text: q.text,
      options: q.options,
      selectedKey: q.selectedKey,
      correctKey: q.correctKey,
      isCorrect: q.isCorrect,
      answeredAt: q.answeredAt,
    })),
  });
});

// Apaga só a NOTA/tentativa (mantém a sala, que volta a ficar disponível
// para uma tentativa nova) — diferente de excluir a sala inteira. Nunca
// afeta outras tentativas: cada uma é um documento independente amarrado
// ao _id da sala, nunca ao nome digitado, então duas salas com o mesmo
// nome de aluno jamais compartilham ou sobrescrevem uma tentativa.
router.delete('/results/:attemptId', async (req, res) => {
  const { attemptId } = req.params;
  if (!isValidObjectId(attemptId)) return res.status(400).json({ success: false, message: 'ID inválido.' });

  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) return res.status(404).json({ success: false, message: 'Tentativa não encontrada.' });

  await ExamEvent.deleteMany({ attemptId });
  await ExamAttempt.findByIdAndDelete(attemptId);
  await Room.findOneAndUpdate(
    { _id: attempt.roomId, currentAttemptId: attempt._id },
    { currentAttemptId: null, status: 'pending' },
  );

  await logSecurityEvent('result_deleted_by_admin', { meta: { attemptId, roomId: attempt.roomId?.toString() }, ip: req.ip });
  res.json({ success: true });
});

router.get('/exam-events', async (req, res) => {
  const { roomId, attemptId } = req.query;
  const filter = {};
  if (roomId && isValidObjectId(roomId)) filter.roomId = roomId;
  if (attemptId && isValidObjectId(attemptId)) filter.attemptId = attemptId;

  const events = await ExamEvent.find(filter).sort({ at: -1 }).limit(500).lean();
  res.json({ success: true, events });
});

router.get('/security-logs', async (req, res) => {
  const logs = await SecurityLog.find().sort({ at: -1 }).limit(300).lean();
  res.json({ success: true, logs });
});

module.exports = router;
