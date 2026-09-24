const { mongoose } = require('../config/db');

// Modelos das mensagens da integração TCEL (editor "Mensagens do Bot").
// Só existe documento para modelos que o admin já editou; os demais usam o
// padrão do código (botghost/templates/defaults.js). Guardam só texto com
// placeholders — nunca links reais nem dados de alunos.
const versionSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  message: { type: mongoose.Schema.Types.Mixed, required: true },
  action: { type: String, enum: ['publish', 'restore_default'], required: true },
  by: { type: String, required: true },
  at: { type: Date, default: Date.now },
}, { _id: false });

const messageTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  draft: { type: mongoose.Schema.Types.Mixed, default: null },
  draftUpdatedBy: { type: String, default: null },
  draftUpdatedAt: { type: Date, default: null },
  published: { type: mongoose.Schema.Types.Mixed, default: null },
  publishedVersion: { type: Number, default: 0 },
  publishedBy: { type: String, default: null },
  publishedAt: { type: Date, default: null },
  versions: { type: [versionSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
