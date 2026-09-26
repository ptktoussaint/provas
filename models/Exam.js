const { mongoose } = require('../config/db');

const examSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  imageUrl: { type: String, default: null },
  introVideoUrl: { type: String, default: null },
  questionCount: { type: Number, default: 50, min: 1 },
  pointsPerQuestion: { type: Number, default: 2, min: 0 },
  durationMinutes: { type: Number, default: 120, min: 1 },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Tela de boas-vindas: vídeo ligado/desligado (ligado = comportamento
  // antigo: vídeo da prova ou o padrão da plataforma, se houver) e textos
  // próprios para aluno e fiscal (vazio = texto padrão da página).
  showIntroVideo: { type: Boolean, default: true },
  welcomeTextStudent: { type: String, default: null },
  welcomeTextProctor: { type: String, default: null },

  // ---- Grupo e integração (BotGhost) ----
  // Identificador estável da prova para integrações: não muda quando o nome
  // exibido muda. "tcel" é reservado: é SEMPRE a prova do /provas-tcel
  // (ver lib/examGroups.js). Provas antigas recebem o slug na migração.
  slug: { type: String, default: undefined, trim: true, lowercase: true },
  // TCEL = fluxo antigo (/provas-tcel); DAFP = novo fluxo (/provas-dafp). O
  // grupo — nunca o nome — decide em qual consulta a prova aparece.
  group: { type: String, enum: ['TCEL', 'DAFP'], default: 'TCEL' },
  // Aprovação automática: nota da prova >= passingScore → aprovado. Os
  // cargos são só devolvidos ao BotGhost (o site não mexe em cargos).
  autoApproval: { type: Boolean, default: false },
  passingScore: { type: Number, default: null },
  approvedRoleId: { type: String, default: null },
  failedRoleId: { type: String, default: null },
  // Canal do resultado desta prova; vazio = canal padrão DAFP da aba
  // Integração BotGhost.
  resultChannelId: { type: String, default: null },
}, { timestamps: true });

examSchema.index({ slug: 1 }, { unique: true, sparse: true });
examSchema.index({ group: 1, active: 1 });

module.exports = mongoose.model('Exam', examSchema);
