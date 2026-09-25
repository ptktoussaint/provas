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

// Histórico de ajustes/exclusão/vínculo feitos pelo admin sobre o
// resultado — quem, quando, por quê, antes e depois.
const auditEntrySchema = new mongoose.Schema({
  type: { type: String, required: true },
  at: { type: Date, default: Date.now },
  by: { type: String, required: true },
  reason: { type: String, required: true },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
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
  // Nomes (rótulos dos links) de todo fiscal que se conectou durante esta
  // tentativa — preenchido ao iniciar a prova (para quem já estava
  // presente) e a cada nova conexão de fiscal depois disso. Sem duplicatas
  // (reconectar não adiciona o mesmo nome de novo).
  proctorNames: { type: [String], default: [] },

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

  // ---- Integração Discord e gestão de resultados ----
  // Vínculo copiado da sala no início da tentativa: continua existindo
  // mesmo que a sala seja excluída depois. Nunca vem do navegador do aluno.
  discordGuildId: { type: String, default: null },
  discordUserId: { type: String, default: null },
  // Fiscal principal e foto do aluno, copiados da sala no início da
  // tentativa (cada tentativa guarda os seus — segunda prova do mesmo aluno
  // numa sala nova tem o seu próprio fiscal). Tentativas antigas: null.
  supervisorDiscordId: { type: String, default: null },
  supervisorDisplayName: { type: String, default: null },
  studentAvatarUrl: { type: String, default: null },
  // Pontuação máxima congelada no momento da prova (questões sorteadas ×
  // pontos por questão). Tentativas antigas sem este campo usam o mesmo
  // cálculo a partir do snapshot — ver lib/results.js maxScoreOf().
  maxScore: { type: Number, default: null },
  // Nota ajustada manualmente pelo admin. A nota calculada (score) e os
  // acertos/erros nunca são alterados — quando existe, esta é a efetiva.
  adjustedScore: { type: Number, default: null },
  // Pontos da prova oral, lançados pelo admin e SOMADOS à nota da prova
  // escrita (a nota final pode passar da pontuação máxima da escrita).
  oralScore: { type: Number, default: null },
  // Arquivado: continua no admin (filtro), mas some da consulta do bot e
  // dos candidatos à promoção. Diferente de excluir: não mexe na sala nem
  // na mensagem já publicada.
  archivedAt: { type: Date, default: null },
  archivedBy: { type: String, default: null },
  // Incrementado a cada mudança relevante do resultado (finalização,
  // ajuste, exclusão, vínculo). A fila do Discord usa isto para nunca
  // publicar uma versão antiga por cima de uma mais nova.
  revision: { type: Number, default: 0 },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: null },
  deleteReason: { type: String, default: null },
  auditTrail: { type: [auditEntrySchema], default: [] },
  discordSync: {
    wantsMessage: { type: Boolean, default: false },
    syncedRevision: { type: Number, default: 0 },
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
}, { timestamps: true });

examAttemptSchema.index({ roomId: 1, status: 1 });
examAttemptSchema.index({ discordGuildId: 1, discordUserId: 1, deletedAt: 1 });

module.exports = mongoose.model('ExamAttempt', examAttemptSchema);
