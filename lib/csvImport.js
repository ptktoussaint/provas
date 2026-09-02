const { parseCsv } = require('./csv');
const { OPTION_KEYS } = require('./constants');

// Nomes de coluna aceitos no CSV de importação do banco de questões
// (requisito #4: "preparar arquitetura para futuramente permitir
// importação por CSV/Excel"). O cabeçalho é comparado sem acentos,
// maiúsculas ou separador (espaço/hífen/underscore tratados como iguais)
// para tolerar variações comuns de planilha.
const EXPECTED_COLUMNS = ['pergunta', 'alternativa_a', 'alternativa_b', 'alternativa_c', 'alternativa_d', 'correta'];

function normalizeHeaderCell(cell) {
  return String(cell || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');
}

// Converte o texto de um CSV em questões prontas para inserir no banco,
// junto com uma lista de erros por linha (o import é parcial: linhas
// inválidas são reportadas, as válidas ainda assim são importadas).
function parseQuestionsCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    return { questions: [], errors: [{ row: 0, reason: 'Arquivo CSV vazio.' }] };
  }

  const header = rows[0].map(normalizeHeaderCell);
  const columnIndex = {};
  for (const col of EXPECTED_COLUMNS) columnIndex[col] = header.indexOf(col);

  const missing = EXPECTED_COLUMNS.filter((col) => columnIndex[col] === -1);
  if (missing.length > 0) {
    return {
      questions: [],
      errors: [{ row: 1, reason: `Colunas obrigatórias ausentes no cabeçalho: ${missing.join(', ')}. Esperado: ${EXPECTED_COLUMNS.join(', ')}.` }],
    };
  }

  const questions = [];
  const errors = [];

  for (let i = 1; i < rows.length; i += 1) {
    const rowNumber = i + 1; // linha 1 é o cabeçalho
    const row = rows[i];
    if (row.every((cell) => !String(cell).trim())) continue; // linha em branco

    const text = String(row[columnIndex.pergunta] || '').trim();
    const optionTexts = {
      A: String(row[columnIndex.alternativa_a] || '').trim(),
      B: String(row[columnIndex.alternativa_b] || '').trim(),
      C: String(row[columnIndex.alternativa_c] || '').trim(),
      D: String(row[columnIndex.alternativa_d] || '').trim(),
    };
    const correctRaw = String(row[columnIndex.correta] || '').trim().toUpperCase();

    if (!text) {
      errors.push({ row: rowNumber, reason: 'Pergunta vazia.' });
      continue;
    }
    const missingOptions = OPTION_KEYS.filter((k) => !optionTexts[k]);
    if (missingOptions.length > 0) {
      errors.push({ row: rowNumber, reason: `Alternativa(s) vazia(s): ${missingOptions.join(', ')}.` });
      continue;
    }
    if (!OPTION_KEYS.includes(correctRaw)) {
      errors.push({ row: rowNumber, reason: `Coluna "correta" precisa ser ${OPTION_KEYS.join('/')} (veio "${row[columnIndex.correta] || ''}").` });
      continue;
    }

    questions.push({
      text,
      options: OPTION_KEYS.map((k) => ({ key: k, text: optionTexts[k] })),
      correctKey: correctRaw,
    });
  }

  return { questions, errors };
}

module.exports = { parseQuestionsCsv, EXPECTED_COLUMNS };
