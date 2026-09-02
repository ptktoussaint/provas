// Transforma um documento de tentativa no payload seguro para o aluno.
// Isto é a barreira central contra vazamento de gabarito/nota: qualquer rota
// ou evento de socket que responde ao aluno DEVE passar pelo attempt aqui,
// nunca serializar o documento Mongoose diretamente (requisito #43).
function toStudentAttemptView(attempt) {
  const total = attempt.snapshot.length;
  const answered = attempt.snapshot.filter((q) => q.selectedKey).length;

  return {
    attemptId: attempt._id.toString(),
    status: attempt.status,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    durationMinutes: attempt.durationMinutes,
    totalQuestions: total,
    answeredCount: answered,
    questions: attempt.snapshot.map((q) => ({
      order: q.order,
      text: q.text,
      options: q.options.map((o) => ({ key: o.key, text: o.text })),
      selectedKey: q.selectedKey || null,
    })),
  };
}

function toStudentQuestionView(snapshotQuestion) {
  return {
    order: snapshotQuestion.order,
    text: snapshotQuestion.text,
    options: snapshotQuestion.options.map((o) => ({ key: o.key, text: o.text })),
    selectedKey: snapshotQuestion.selectedKey || null,
  };
}

module.exports = { toStudentAttemptView, toStudentQuestionView };
