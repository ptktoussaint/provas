const { mongoose } = require('../config/db');

// Log de segurança separado do log de auditoria de prova — cobre eventos de
// autenticação e acesso administrativo. Nunca gravar senha, token completo
// ou segredo aqui (ver lib/securityLog.js).
const securityLogSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: null },
  at: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('SecurityLog', securityLogSchema);
