const { mongoose } = require('../config/db');

const stepSchema = new mongoose.Schema({
  type: { type: String, enum: ['addRole', 'removeRole', 'setNickname'], required: true },
  roleId: { type: String, default: null },
  nickname: { type: String, default: null },
  status: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  // true quando a etapa já estava no estado desejado (reconciliação) e
  // nenhuma chamada ao Discord foi necessária.
  alreadyInPlace: { type: Boolean, default: false },
  error: { type: String, default: null },
  at: { type: Date, default: null },
}, { _id: false });

// Uma promoção executada (ou em execução) para UM usuário. Cargos e apelido
// não são uma transação atômica no Discord, então cada etapa tem seu
// próprio estado e a retomada só refaz o que ficou pendente/falhou.
const promotionSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  discordUserId: { type: String, required: true },
  // `${guildId}:${discordUserId}` enquanto a promoção conta como "já
  // promovido por esta integração". Índice único impede duas promoções
  // simultâneas/duplicadas do mesmo usuário. Removido ($unset) apenas por
  // resolução administrativa explícita.
  lockKey: { type: String, default: undefined },
  draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionDraft', required: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true },
  scoreAtPromotion: { type: Number, default: null },
  // Revisão do resultado na confirmação: se mudar antes de começar, a
  // pessoa vai para revisão em vez de ser promovida com nota diferente.
  revisionAtConfirm: { type: Number, default: null },
  maxScore: { type: Number, default: null },
  operatorId: { type: String, required: true },
  nomeRP: { type: String, required: true },
  idRP: { type: String, required: true },
  nickname: { type: String, required: true },
  steps: { type: [stepSchema], default: [] },
  status: {
    type: String,
    // needs_review: estado real no Discord exige decisão humana (ex.: já
    // tinha os cargos fora da integração, ou a nota mudou antes de começar).
    // blocked: resultado excluído antes de iniciar — não será executada.
    enum: ['pending', 'in_progress', 'completed', 'partial', 'failed', 'needs_review', 'blocked'],
    default: 'pending',
  },
  // Etapa que o executor (BotGhost) deve relatar a seguir.
  phase: { type: String, enum: ['awaiting_precheck', 'awaiting_result', 'done'], default: 'awaiting_precheck' },
  reviewReason: { type: String, default: null },
  // Evidências relatadas pelo executor autenticado (BotGhost), lidas do
  // Discord por ele — não é leitura independente do site.
  evidence: {
    pre: {
      roleIds: { type: [String], default: undefined },
      nickname: { type: String, default: null },
      at: { type: Date, default: null },
    },
    post: {
      roleIds: { type: [String], default: undefined },
      nickname: { type: String, default: null },
      at: { type: Date, default: null },
    },
  },
  // Conflito registrado (ex.: resultado excluído depois de iniciada a
  // promoção) — o Mongo e o Discord não mudam juntos atomicamente.
  conflict: { type: String, default: null },
  startedAt: { type: Date, default: null },
  // Membro já tinha os cargos de destino antes (atribuídos fora do bot):
  // não entra no anúncio automático.
  preexisting: { type: Boolean, default: false },
  announcementKey: { type: String, default: null },
  announced: { type: Boolean, default: false },
  announcedAt: { type: Date, default: null },
  announcementMessageId: { type: String, default: null },
  retryCount: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  completedAt: { type: Date, default: null },
  resolvedAdministratively: {
    by: { type: String, default: null },
    at: { type: Date, default: null },
    reason: { type: String, default: null },
  },
}, { timestamps: true });

promotionSchema.index({ lockKey: 1 }, { unique: true, sparse: true });
promotionSchema.index({ guildId: 1, discordUserId: 1 });
promotionSchema.index({ draftId: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
