const { mongoose } = require('../config/db');

// Configuração editável pelo admin (aba Discord). Documento único. O token
// do bot NUNCA fica aqui — só nas variáveis de ambiente (DISCORD_BOT_TOKEN).
// Todos os IDs do Discord são String (passam de 2^53).
const discordConfigSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  panelChannelId: { type: String, default: null },
  resultsChannelId: { type: String, default: null },
  operatorRoles: {
    generate: { type: [String], default: [] },
    results: { type: [String], default: [] },
    promote: { type: [String], default: [] },
  },
  defaultExamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  promotion: {
    addRoleIds: { type: [String], default: () => ['1231023397069258844', '1057349963203498105'] },
    removeRoleIds: { type: [String], default: () => ['1057349976482664569'] },
    announceChannelId: { type: String, default: '1396947587235578017' },
    // Cargo mencionado no anúncio ("Parabéns aos promovidos para <@&...>").
    announceRoleId: { type: String, default: '1231023397069258844' },
    nicknameTemplate: { type: String, default: '『TCEL•B』{nome} | {idRP}' },
  },
  // Mensagem do painel publicada por /provatcel — reaproveitada/atualizada
  // em vez de criar painéis repetidos.
  panelMessage: {
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
  },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  updatedBy: { type: String, default: null },
}, { timestamps: true });

discordConfigSchema.statics.getOrCreate = async function getOrCreate() {
  const doc = await this.findOneAndUpdate(
    { singleton: 'main' },
    { $setOnInsert: { singleton: 'main' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc;
};

module.exports = mongoose.model('DiscordConfig', discordConfigSchema);
