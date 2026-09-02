const ExamEvent = require('../models/ExamEvent');

async function logExamEvent({ roomId, attemptId = null, examId = null, actor, type, meta = null }) {
  try {
    await ExamEvent.create({ roomId, attemptId, examId, actor, type, meta });
  } catch (err) {
    console.error('[exam-event] falha ao gravar evento', type, err.message);
  }
}

module.exports = { logExamEvent };
