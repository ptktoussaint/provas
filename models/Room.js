const { mongoose } = require('../config/db');

// Um token de fiscal por professor convidado para aquela sala. Guardamos só
// o hash (sha256) do token — o valor bruto só existe no link entregue ao
// admin no momento da criação, nunca mais é recuperável do banco.
const proctorTokenSchema = new mongoose.Schema({
  label: { type: String, default: 'Fiscal' },
  tokenHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
}, { _id: true });

const roomSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  roomLabel: { type: String, required: true }, // ex.: "Sala 01"
  studentName: { type: String, required: true, trim: true },
  studentTokenHash: { type: String, required: true, unique: true },
  proctorTokens: { type: [proctorTokenSchema], default: [] },
  status: { type: String, enum: ['pending', 'active', 'finished', 'closed'], default: 'pending' },
  currentAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

roomSchema.index({ 'proctorTokens.tokenHash': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Room', roomSchema);
