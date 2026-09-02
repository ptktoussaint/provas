const { mongoose } = require('../config/db');

// Documento único (singleton) com as configurações globais da plataforma.
const settingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  platformName: { type: String, default: 'Provas Live' },
  logoUrl: { type: String, default: null },
  introVideoYoutubeId: { type: String, default: null },
}, { timestamps: true });

settingsSchema.statics.getOrCreate = async function getOrCreate() {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) {
    doc = await this.create({ singleton: 'main' });
  }
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
