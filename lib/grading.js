const { OPTION_KEYS } = require('./constants');

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Seleciona `count` questões aleatórias entre as ativas fornecidas. Feito
// sempre no backend (requisito #5) — o cliente nunca decide quais questões
// compõem a prova.
function pickRandomQuestions(activeQuestions, count) {
  const shuffled = shuffle(activeQuestions);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// Re-rotula as alternativas em posições A/B/C/D embaralhadas, preservando
// qual delas é a correta. O gabarito (correctKey) resultante é relativo à
// NOVA ordem, não à ordem original da questão no banco.
function shuffleOptions(question) {
  const originalCorrect = question.options.find((o) => o.key === question.correctKey);
  const shuffledTexts = shuffle(question.options.map((o) => ({
    text: o.text,
    wasCorrect: o.key === question.correctKey,
  })));

  const options = shuffledTexts.map((item, index) => ({
    key: OPTION_KEYS[index],
    text: item.text,
  }));
  const correctKey = OPTION_KEYS[shuffledTexts.findIndex((item) => item.wasCorrect)];

  if (!correctKey || !originalCorrect) {
    throw new Error('Questão com gabarito inconsistente — não é possível gerar a prova.');
  }

  return { options, correctKey };
}

// Constrói o snapshot imutável de uma tentativa a partir das questões
// selecionadas. Esse objeto — e só ele — é o que o aluno vai ver; editar a
// questão original depois não afeta tentativas já criadas (requisito #6).
function buildSnapshot(questions) {
  return questions.map((question, index) => {
    const { options, correctKey } = shuffleOptions(question);
    return {
      order: index + 1,
      questionId: question._id,
      text: question.text,
      options,
      correctKey,
      selectedKey: null,
      isCorrect: null,
      answeredAt: null,
    };
  });
}

// Única função autorizada a decidir se uma resposta está certa. Nunca deve
// ser espelhada no frontend (requisitos #10, #43, #44).
function gradeAttempt(attempt) {
  let correctCount = 0;
  let wrongCount = 0;
  let unansweredCount = 0;

  for (const q of attempt.snapshot) {
    if (q.selectedKey === null || q.selectedKey === undefined) {
      unansweredCount += 1;
    } else if (q.isCorrect) {
      correctCount += 1;
    } else {
      wrongCount += 1;
    }
  }

  const score = correctCount * attempt.pointsPerQuestion;
  return { score, correctCount, wrongCount, unansweredCount };
}

module.exports = { pickRandomQuestions, shuffleOptions, buildSnapshot, gradeAttempt, shuffle };
