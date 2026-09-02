const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../lib/csv');

test('parseCsv separa linhas e colunas simples', () => {
  const rows = parseCsv('a,b,c\n1,2,3');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv respeita campos entre aspas com vírgula embutida', () => {
  const rows = parseCsv('pergunta,alt\n"Qual, exatamente, a capital?",Brasília');
  assert.deepEqual(rows, [
    ['pergunta', 'alt'],
    ['Qual, exatamente, a capital?', 'Brasília'],
  ]);
});

test('parseCsv trata aspas escapadas como "" dentro de um campo entre aspas', () => {
  const rows = parseCsv('texto\n"Ele disse ""oi"" pra mim"');
  assert.deepEqual(rows, [['texto'], ['Ele disse "oi" pra mim']]);
});

test('parseCsv suporta quebra de linha dentro de um campo entre aspas', () => {
  const rows = parseCsv('a,b\n"linha 1\nlinha 2",x');
  assert.deepEqual(rows, [['a', 'b'], ['linha 1\nlinha 2', 'x']]);
});

test('parseCsv ignora linhas totalmente vazias', () => {
  const rows = parseCsv('a,b\n\n1,2\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsv lida com CRLF', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});
