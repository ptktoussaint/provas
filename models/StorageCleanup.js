const { mongoose } = require('../config/db');

// Prévia e execução da "Limpar armazenamento" (Segurança & auditoria). Cada
// prévia é um documento com a data de corte FIXADA no servidor; a execução
// só aceita uma prévia válida (mesmo admin, mesma data de corte, dentro da
// validade) e reaproveita o documento para guardar progresso e resultado.
// lockKey 'global' (índice único) impede duas limpezas ao mesmo tempo.
// Estes registros nunca são apagados pela limpeza.
const storageCleanupSchema = new mongoose.Schema({
  status: { type: String, enum: ['preview', 'running', 'done', 'failed', 'interrupted'], default: 'preview', index: true },
  days: { type: Number, required: true },
  cutoff: { type: Date, required: true },
  createdBy: { type: String, required: true },
  createdByName: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  lockKey: { type: String, default: undefined },
  preview: { type: mongoose.Schema.Types.Mixed, default: null },
  progress: { type: mongoose.Schema.Types.Mixed, default: null },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { timestamps: true });

storageCleanupSchema.index({ lockKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('StorageCleanup', storageCleanupSchema);
