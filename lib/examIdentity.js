const Exam = require('../models/Exam');

// Nome exibido nas telas do aluno e do fiscal: SEMPRE o da prova vinculada
// à sala (Room.examId), lido do banco no servidor — nunca um valor global
// (o antigo "nome da plataforma" fazia toda sala aparecer como "Prova TCEL"),
// nem a última prova escolhida, nem algo enviado pelo navegador. Salas
// antigas usam o mesmo vínculo; sem prova identificável, "Prova".
const FALLBACK_EXAM_NAME = 'Prova';

function examDisplayName(exam) {
  const name = exam && typeof exam.name === 'string' ? exam.name.trim() : '';
  return name || FALLBACK_EXAM_NAME;
}

async function resolveRoomExam(room) {
  if (!room || !room.examId) return null;
  return Exam.findById(room.examId);
}

module.exports = { FALLBACK_EXAM_NAME, examDisplayName, resolveRoomExam };
