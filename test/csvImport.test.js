const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestionsCsv } = require('../lib/csvImport');

const HEADER = 'pergunta,alternativa_a,alternativa_b,alternativa_c,alternativa_d,correta';

test('parseQuestionsCsv importa linhas válidas', () => {
  const csv = `${HEADER}\nQual a capital do Brasil?,Rio de Janeiro,Brasília,São Paulo,Salvador,B`;
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correctKey, 'B');
  assert.equal(questions[0].options.find((o) => o.key === 'B').text, 'Brasília');
});

test('parseQuestionsCsv aceita cabeçalho com espaços/maiúsculas/acentos', () => {
  const csv = 'Pergunta,Alternativa A,Alternativa B,Alternativa C,Alternativa D,Correta\nQ1,a,b,c,d,a';
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correctKey, 'A');
});

test('parseQuestionsCsv reporta cabeçalho com coluna faltando', () => {
  const csv = 'pergunta,alternativa_a,alternativa_b,alternativa_c,correta\nQ1,a,b,c,a';
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(questions.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /alternativa_d/);
});

test('parseQuestionsCsv reporta linha com pergunta vazia sem derrubar as outras', () => {
  const csv = `${HEADER}\n,a,b,c,d,a\nQ2,a,b,c,d,c`;
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].text, 'Q2');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 2);
});

test('parseQuestionsCsv reporta linha com alternativa vazia', () => {
  const csv = `${HEADER}\nQ1,a,,c,d,a`;
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(questions.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /B/);
});

test('parseQuestionsCsv reporta coluna "correta" inválida', () => {
  const csv = `${HEADER}\nQ1,a,b,c,d,X`;
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(questions.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /A\/B\/C\/D/);
});

test('parseQuestionsCsv ignora linhas totalmente em branco no meio do arquivo', () => {
  const csv = `${HEADER}\nQ1,a,b,c,d,a\n,,,,,\nQ2,a,b,c,d,b`;
  const { questions, errors } = parseQuestionsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 2);
});

test('parseQuestionsCsv importa as 50 linhas de um arquivo grande', () => {
  const rows = [HEADER];
  for (let i = 1; i <= 50; i += 1) rows.push(`Questão ${i}?,A${i},B${i},C${i},D${i},${['A', 'B', 'C', 'D'][i % 4]}`);
  const { questions, errors } = parseQuestionsCsv(rows.join('\n'));
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 50);
});
