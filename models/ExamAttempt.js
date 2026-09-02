const { mongoose } = require('../config/db');

// Snapshot imutável de uma questão exatamente como foi apresentada nesta
// tentativa (texto, alternativas e ordem congelados no momento da geração).
// Editar a questão original depois NUNCA altera este registro.
const snapshotQuestionSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  text: { type: String, required: true },
  options: [{ key: String, text: String, _id: false }],
  correctKey: { type: String, required: true }, // nunca serializado para o aluno — ver lib/studentView.js
  selectedKey: { type: String, default: null },
  isCorrect: { type: Boolean, default: null },
  answeredAt: { type: Date, default: null },
}, { _id: false });

const focusEventSchema = new mongoose.Schema({
  type: { type: String, enum: ['blur', 'focus', 'hidden', 'visible'], required: true },
  at: { type: Date, default: Date.now },
}, { _id: false });

const streamEventSchema = new mongoose.Schema({
  type: { type: String, required: true },
  at: { type: Date, default: Date.now },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const examAttemptSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  studentName: { type: String, required: true },
  // Cópia do rótulo da sala no momento da prova — a sala pode ser excluída
  // depois (ex.: para não acumular na lista) sem que o arquivo do resultado
  // perca essa informação; nunca depende de populate('roomId') continuar
  // resolvendo um documento que talvez não exista mais.
  roomLabel: { type: String, default: null },

  status: {
    type: String,
    enum: ['in_progress', 'finished', 'finished_timeout'],
    default: 'in_progress',
    index: true,
  },

  startedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  durationMinutes: { type: Number, required: true },
  pointsPerQuestion: { type: Number, required: true },

  snapshot: { type: [snapshotQuestionSchema], required: true },

  score: { type: Number, default: 0 },
  correctCount: { type: Number, default: 0 },
  wrongCount: { type: Number, default: 0 },
  unansweredCount: { type: Number, default: 0 },

  focusEvents: { type: [focusEventSchema], default: [] },
  totalFocusLossMs: { type: Number, default: 0 },
  lastFocusLostAt: { type: Date, default: null },
  isOutOfFocus: { type: Boolean, default: false },

  streamStatus: {
    type: String,
    enum: ['awaiting', 'capturing', 'connecting', 'negotiating', 'live', 'reconnecting', 'interrupted', 'error'],
    default: 'awaiting',
  },
  streamEvents: { type: [streamEventSchema], default: [] },

  lastActivityAt: { type: Date, default: Date.now },
}, { timestamps: true });

examAttemptSchema.index({ roomId: 1, status: 1 });

module.exports = mongoose.model('ExamAttempt', examAttemptSchema);
