const { mongoose } = require('../config/db');

// Pedido de "Gerar Prova" em andamento no Discord. Guardado no banco (e não
// em memória) para que os botões continuem funcionando após um reinício, e
// para que um clique repetido em "Criar sala" seja detectado.
const discordRequestSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  operatorId: { type: String, required: true },
  operatorName: { type: String, default: null },
  targetUserId: { type: String, required: true },
  studentName: { type: String, required: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  status: { type: String, enum: ['pending', 'creating', 'done', 'cancelled'], default: 'pending' },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

module.exports = mongoose.model('DiscordRequest', discordRequestSchema);
