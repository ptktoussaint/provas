const test = require('node:test');
const assert = require('node:assert/strict');
const { pickRandomQuestions, shuffleOptions, buildSnapshot, gradeAttempt } = require('../lib/grading');

function makeQuestion(overrides = {}) {
  return {
    _id: 'q1',
    text: 'Qual é a capital do Brasil?',
    options: [
      { key: 'A', text: 'Rio de Janeiro' },
      { key: 'B', text: 'Brasília' },
      { key: 'C', text: 'São Paulo' },
      { key: 'D', text: 'Salvador' },
    ],
    correctKey: 'B',
    ...overrides,
  };
}

test('shuffleOptions preserva o conteúdo da alternativa correta após embaralhar', () => {
  for (let i = 0; i < 50; i += 1) {
    const q = makeQuestion();
    const { options, correctKey } = shuffleOptions(q);
    assert.equal(options.length, 4);
    assert.deepEqual(new Set(options.map((o) => o.key)), new Set(['A', 'B', 'C', 'D']));
    const correctOption = options.find((o) => o.key === correctKey);
    assert.equal(correctOption.text, 'Brasília');
  }
});

test('pickRandomQuestions nunca retorna mais que o disponível e não duplica', () => {
  const pool = Array.from({ length: 10 }, (_, i) => makeQuestion({ _id: `q${i}` }));
  const picked = pickRandomQuestions(pool, 5);
  assert.equal(picked.length, 5);
  const ids = picked.map((q) => q._id);
  assert.equal(new Set(ids).size, 5);

  const pickedAll = pickRandomQuestions(pool, 100);
  assert.equal(pickedAll.length, 10);
});

test('buildSnapshot gera gabarito consistente com a nova ordem de alternativas', () => {
  const pool = [makeQuestion({ _id: 'q1', correctKey: 'A' }), makeQuestion({ _id: 'q2', correctKey: 'D' })];
  const snapshot = buildSnapshot(pool);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].order, 1);
  assert.equal(snapshot[1].order, 2);

  for (const sq of snapshot) {
    const correctOption = sq.options.find((o) => o.key === sq.correctKey);
    assert.ok(correctOption, 'a chave correta do snapshot deve existir entre as opções embaralhadas');
  }
});

test('gradeAttempt calcula nota exclusivamente a partir do snapshot (2 pontos por acerto)', () => {
  const attempt = {
    pointsPerQuestion: 2,
    snapshot: [
      { selectedKey: 'A', isCorrect: true },
      { selectedKey: 'B', isCorrect: false },
      { selectedKey: null, isCorrect: null },
      { selectedKey: 'C', isCorrect: true },
    ],
  };
  const result = gradeAttempt(attempt);
  assert.equal(result.correctCount, 2);
  assert.equal(result.wrongCount, 1);
  assert.equal(result.unansweredCount, 1);
  assert.equal(result.score, 4);
});

test('gradeAttempt: 50 acertos com 2 pontos cada resulta em 100 pontos (config padrão)', () => {
  const snapshot = Array.from({ length: 50 }, () => ({ selectedKey: 'A', isCorrect: true }));
  const attempt = { pointsPerQuestion: 2, snapshot };
  const result = gradeAttempt(attempt);
  assert.equal(result.score, 100);
});
