const { mongoose } = require('../config/db');
const { OPTION_KEYS } = require('../lib/constants');

const optionSchema = new mongoose.Schema({
  key: { type: String, enum: OPTION_KEYS, required: true },
  text: { type: String, required: true, trim: true },
}, { _id: false });

const questionSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  text: { type: String, required: true, trim: true },
  options: {
    type: [optionSchema],
    validate: {
      validator: (opts) => opts.length === 4 && OPTION_KEYS.every((k) => opts.some((o) => o.key === k)),
      message: 'A questão precisa ter exatamente as alternativas A, B, C e D.',
    },
  },
  correctKey: { type: String, enum: OPTION_KEYS, required: true },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Question', questionSchema);
