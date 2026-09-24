const { mongoose } = require('../config/db');

// Outbox persistente das operações externas no Discord (notificação de
// resultado, execução de promoção, anúncio). A prova nunca espera por isto:
// a tarefa é gravada e processada depois, com retentativas, e sobrevive a
// reinícios do servidor. `key` é única por evento/revisão — reenfileirar o
// mesmo evento é inofensivo.
const discordTaskSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['result_sync', 'promotion_execute', 'promotion_announce'], required: true, index: true },
  status: { type: String, enum: ['pending', 'processing', 'done', 'failed', 'superseded'], default: 'pending', index: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', default: null },
  revision: { type: Number, default: null },
  promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion', default: null },
  draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionDraft', default: null },
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  // Progresso parcial persistido (ex.: quais partes do anúncio já foram
  // enviadas) — retentativa nunca repete o que já foi confirmado.
  progress: { type: mongoose.Schema.Types.Mixed, default: null },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 8 },
  nextRunAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  note: { type: String, default: null },
}, { timestamps: true });

discordTaskSchema.index({ status: 1, nextRunAt: 1 });
discordTaskSchema.index({ attemptId: 1, revision: -1 });

module.exports = mongoose.model('DiscordTask', discordTaskSchema);
