const { mongoose } = require('../config/db');

// Aviso a ser publicado pelo bot do BotGhost (fila durável no Mongo).
// Ciclo: pending → dispatched (webhook disparado; 200 NÃO prova entrega)
//        → claimed (BotGhost reservou e recebeu o conteúdo ATUAL)
//        → delivered (BotGhost confirmou com o ID real da mensagem).
// "ambiguous": a reserva de um ENVIO venceu sem confirmação — a mensagem
// pode ter saído ou não; nunca é reenviada automaticamente (evita
// duplicar), fica para o admin resolver.
const historySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  event: { type: String, required: true },
  detail: { type: String, default: null },
}, { _id: false });

const integrationNotificationSchema = new mongoose.Schema({
  // dafp_started: início real de uma prova DAFP — sem mensagem, só a
  // remoção da Role base (ver botghost/notifications.js).
  kind: { type: String, enum: ['result', 'promotion_announcement', 'template_test', 'panel_update', 'dafp_started'], required: true, index: true },
  key: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ['pending', 'dispatched', 'claimed', 'delivered', 'failed', 'ambiguous', 'cancelled'],
    default: 'pending',
    index: true,
  },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', default: null, index: true },
  draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionDraft', default: null },
  templateKey: { type: String, default: null },
  chunkIndex: { type: Number, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  // Resultados: revisão que precisa estar publicada; a entregue fica em
  // deliveredRevision. Mudou de novo enquanto reservado → needsUpdate.
  targetRevision: { type: Number, default: 0 },
  deliveredRevision: { type: Number, default: null },
  needsUpdate: { type: Boolean, default: false },
  dispatchAttempts: { type: Number, default: 0 },
  maxDispatchAttempts: { type: Number, default: 6 },
  nextDispatchAt: { type: Date, default: Date.now },
  dispatchedAt: { type: Date, default: null },
  lease: {
    token: { type: String, default: null },
    until: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    action: { type: String, default: null }, // send | edit | none (só cargos)
    renderedRevision: { type: Number, default: null },
    channelId: { type: String, default: null },
  },
  claimCount: { type: Number, default: 0 },
  message: {
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
  },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  history: { type: [historySchema], default: [] },
}, { timestamps: true });

integrationNotificationSchema.index({ status: 1, nextDispatchAt: 1 });

module.exports = mongoose.model('IntegrationNotification', integrationNotificationSchema);
