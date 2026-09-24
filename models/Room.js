const { mongoose } = require('../config/db');

// Um token de fiscal por professor convidado para aquela sala. Guardamos só
// o hash (sha256) do token — o valor bruto só existe no link entregue ao
// admin no momento da criação, nunca mais é recuperável do banco.
const proctorTokenSchema = new mongoose.Schema({
  label: { type: String, default: 'Fiscal' },
  tokenHash: { type: String, required: true },
  // Preenchido quando o link foi gerado pelo bot para o próprio operador do
  // Discord (fiscal inicial). IDs do Discord são sempre String: passam de
  // 2^53 e perderiam dígitos como Number do JavaScript.
  discordUserId: { type: String, default: null },
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
  createdVia: { type: String, enum: ['admin', 'discord'], default: 'admin' },
  // Destinatário cadastrado pelo operador no Discord. Só é gravado pelo
  // servidor (bot/admin) — nenhuma rota do aluno altera isto. Identifica a
  // quem a sala foi destinada; NÃO prova que quem abriu o link é o dono da
  // conta do Discord.
  discordGuildId: { type: String, default: null },
  discordUserId: { type: String, default: null },
  discordOperator: {
    id: { type: String, default: null },
    name: { type: String, default: null },
  },
  // Pedido de geração que originou a sala — índice único garante que um
  // clique repetido/reenvio da interação nunca cria duas salas.
  discordRequestId: { type: String, default: undefined },
}, { timestamps: true });

roomSchema.index({ 'proctorTokens.tokenHash': 1 }, { unique: true, sparse: true });
roomSchema.index({ discordRequestId: 1 }, { unique: true, sparse: true });
roomSchema.index({ discordGuildId: 1, discordUserId: 1, examId: 1, status: 1 });

module.exports = mongoose.model('Room', roomSchema);
