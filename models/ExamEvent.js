const { mongoose } = require('../config/db');

// Log de auditoria append-only. Uma linha por evento relevante da
// fiscalização — nunca é editado ou removido pela aplicação.
const examEventSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', default: null, index: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  actor: { type: String, enum: ['student', 'proctor', 'admin', 'system'], required: true },
  type: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  at: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('ExamEvent', examEventSchema);
