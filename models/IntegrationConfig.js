const { mongoose } = require('../config/db');

// Configuração da integração com o bot do BotGhost, editada pelo admin (aba
// Integração BotGhost). Documento único. NENHUMA credencial fica aqui: a
// chave do site e a chave do módulo Webhooks ficam só nas variáveis de
// ambiente. Todos os IDs do Discord são String (passam de 2^53).
const integrationConfigSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  // IDs de usuário do Discord autorizados por ação. Complementa (não
  // substitui) as condições de cargo montadas no BotGhost: o site só confia
  // no ID atestado pelo BotGhost autenticado — não consulta o Discord.
  operatorIds: {
    generate: { type: [String], default: [] },
    results: { type: [String], default: [] },
    promote: { type: [String], default: [] },
  },
  defaultExamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  channels: {
    // Opcional: se definido, o site recusa pedidos vindos de outro canal.
    panel: { type: String, default: null },
    results: { type: String, default: null },
    test: { type: String, default: null },
  },
  promotion: {
    addRoleIds: { type: [String], default: () => ['1231023397069258844', '1057349963203498105'] },
    removeRoleIds: { type: [String], default: () => ['1057349976482664569'] },
    announceChannelId: { type: String, default: '1396947587235578017' },
    announceRoleId: { type: String, default: '1231023397069258844' },
    nicknameTemplate: { type: String, default: '『TCEL•B』{nome} | {idRP}' },
  },
  // Mensagem do painel /provatcel registrada pelo BotGhost — "Atualizar
  // painel" edita esta mesma mensagem em vez de publicar outra.
  panelMessage: {
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    updatedAt: { type: Date, default: null },
  },
  status: {
    lastAuthAt: { type: Date, default: null },
    lastAuthRoute: { type: String, default: null },
    lastWebhookOkAt: { type: Date, default: null },
    lastWebhookError: { type: String, default: null },
    lastWebhookErrorAt: { type: Date, default: null },
    lastAckAt: { type: Date, default: null },
  },
  updatedBy: { type: String, default: null },
}, { timestamps: true, collection: 'integrationconfigs' });

integrationConfigSchema.statics.getOrCreate = async function getOrCreate() {
  return this.findOneAndUpdate(
    { singleton: 'main' },
    { $setOnInsert: { singleton: 'main' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

module.exports = mongoose.model('IntegrationConfig', integrationConfigSchema);
