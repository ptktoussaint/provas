const { mongoose } = require('../config/db');

// Totais acumulados que NÃO podem diminuir quando históricos antigos são
// apagados pela limpeza de armazenamento (ex.: "Provas finalizadas" do
// Dashboard, que antes era só a contagem das tentativas no banco).
const historyCounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
}, { timestamps: true });

historyCounterSchema.statics.add = function add(key, n) {
  if (!n) return Promise.resolve();
  return this.updateOne({ key }, { $inc: { value: n } }, { upsert: true });
};

historyCounterSchema.statics.get = async function get(key) {
  const doc = await this.findOne({ key }).lean();
  return doc ? doc.value : 0;
};

module.exports = mongoose.model('HistoryCounter', historyCounterSchema);
