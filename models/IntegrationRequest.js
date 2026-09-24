const { mongoose } = require('../config/db');

// Idempotência das requisições do BotGhost: a mesma chave (ex.:
// {interaction_id}) reenviada numa retentativa devolve a mesma resposta;
// com outro conteúdo, dá conflito. A resposta guardada NUNCA contém links
// de prova (tokens) — só IDs e textos seguros.
const integrationRequestSchema = new mongoose.Schema({
  scopeKey: { type: String, required: true, unique: true },
  route: { type: String, required: true },
  actorDiscordId: { type: String, required: true },
  payloadHash: { type: String, required: true },
  status: { type: String, enum: ['processing', 'done'], default: 'processing' },
  httpStatus: { type: Number, default: null },
  response: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
});

module.exports = mongoose.model('IntegrationRequest', integrationRequestSchema);
