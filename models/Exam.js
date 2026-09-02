const { mongoose } = require('../config/db');

const examSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  imageUrl: { type: String, default: null },
  introVideoUrl: { type: String, default: null },
  questionCount: { type: Number, default: 50, min: 1 },
  pointsPerQuestion: { type: Number, default: 2, min: 0 },
  durationMinutes: { type: Number, default: 120, min: 1 },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Exam', examSchema);
