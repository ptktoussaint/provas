const { mongoose } = require('../config/db');
const { DEFAULT_PLATFORM_NAME, DEFAULT_THEME } = require('../lib/constants');

const themeSchema = new mongoose.Schema({
  primaryColorLight: { type: String, default: DEFAULT_THEME.primaryColorLight },
  primaryColor: { type: String, default: DEFAULT_THEME.primaryColor },
  primaryColorDark: { type: String, default: DEFAULT_THEME.primaryColorDark },
  backgroundColor: { type: String, default: DEFAULT_THEME.backgroundColor },
  cardColor: { type: String, default: DEFAULT_THEME.cardColor },
  backgroundImageUrl: { type: String, default: null },
}, { _id: false });

// Documento único (singleton) com as configurações globais da plataforma —
// nome, logo, vídeo introdutório padrão e toda a identidade visual (cores +
// imagem de fundo), editável pelo admin e aplicada tanto no próprio painel
// quanto na área do aluno/fiscal (ver public/shared/theme.js).
const settingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  platformName: { type: String, default: DEFAULT_PLATFORM_NAME },
  logoUrl: { type: String, default: null },
  introVideoYoutubeId: { type: String, default: null },
  theme: { type: themeSchema, default: () => ({}) },
}, { timestamps: true });

settingsSchema.statics.getOrCreate = async function getOrCreate() {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) {
    doc = await this.create({ singleton: 'main' });
  }
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
