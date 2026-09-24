const { mongoose } = require('../config/db');

const selectionSchema = new mongoose.Schema({
  discordUserId: { type: String, required: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true },
  studentName: { type: String, default: null },
  examName: { type: String, default: null },
  // Nota efetiva e revisão do resultado no momento da seleção — se mudarem
  // até a confirmação, a promoção exige nova revisão.
  scoreAtSelection: { type: Number, default: null },
  maxScore: { type: Number, default: null },
  revisionAtSelection: { type: Number, default: 0 },
  nomeRP: { type: String, default: null },
  // ID do personagem no RP — não confundir com o ID do Discord.
  idRP: { type: String, default: null },
}, { _id: false });

// Rascunho de promoção em lote. Pertence a um operador em um servidor, tem
// prazo e fica no banco: botões antigos seguem funcionando após reinício.
const promotionDraftSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  operatorId: { type: String, required: true },
  status: {
    type: String,
    enum: ['draft', 'review', 'executing', 'completed', 'partial', 'cancelled', 'expired'],
    default: 'draft',
  },
  selections: { type: [selectionSchema], default: [] },
  filterUserId: { type: String, default: null },
  page: { type: Number, default: 0 },
  reviewHash: { type: String, default: null },
  review: { type: mongoose.Schema.Types.Mixed, default: null },
  notice: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  confirmedAt: { type: Date, default: null },
}, { timestamps: true });

promotionDraftSchema.index({ guildId: 1, operatorId: 1, status: 1 });

module.exports = mongoose.model('PromotionDraft', promotionDraftSchema);
