const test = require('node:test');
const assert = require('node:assert/strict');

// Regras puras de grupos TCEL/DAFP e aprovação automática (sem banco).
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:1/sem-banco';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-unitario';
require('mongoose').set('bufferCommands', false);

const { validateExamSettings, computeOutcome, slugify, maxPossibleScore } = require('../lib/examGroups');

const ROLE_A = '800000000000000001';
const ROLE_B = '800000000000000002';
const EXAM = { name: 'Aspirante', slug: 'aspirante', group: 'DAFP', questionCount: 10, pointsPerQuestion: 1 };

test('slug a partir do nome: sem acento, minúsculo, com hífen', () => {
  assert.equal(slugify('Segundo Tenente'), 'segundo-tenente');
  assert.equal(slugify('Capitão'), 'capitao');
  assert.equal(slugify('  Primeiro   Tenente!! '), 'primeiro-tenente');
  assert.equal(slugify('***'), 'prova');
});

test('aprovação automática: nota >= mínima aprova; abaixo reprova; cargo correspondente', () => {
  const exam = { ...EXAM, autoApproval: true, passingScore: 7, approvedRoleId: ROLE_A, failedRoleId: ROLE_B };
  assert.equal(computeOutcome(exam, 8, 10).resultStatus, 'APROVADO');
  assert.equal(computeOutcome(exam, 8, 10).resultRoleId, ROLE_A);
  const equal = computeOutcome(exam, 7, 10);
  assert.equal(equal.resultStatus, 'APROVADO', 'igual à mínima aprova');
  const fail = computeOutcome(exam, 6.99, 10);
  assert.equal(fail.resultStatus, 'REPROVADO');
  assert.equal(fail.resultRoleId, ROLE_B);
  assert.equal(fail.passingScore, 7);
  assert.equal(fail.examSlug, 'aspirante');
});

test('sem aprovação automática: não decide aprovado/reprovado nem devolve cargo', () => {
  const o = computeOutcome({ ...EXAM, autoApproval: false, passingScore: 7, approvedRoleId: ROLE_A, failedRoleId: ROLE_B }, 3, 10);
  assert.equal(o.resultStatus, 'NAO_APLICAVEL');
  assert.equal(o.resultRoleId, null);
  assert.equal(o.autoApproval, false);
  assert.equal(o.score, 3);
});

test('painel: aprovação automática exige nota mínima e os dois cargos; mínima não passa da máxima', () => {
  let r = validateExamSettings({ autoApproval: 'true' }, EXAM, EXAM);
  assert.equal(r.errors.length, 3, r.errors.join(' | '));
  r = validateExamSettings({ autoApproval: true, passingScore: '11', approvedRoleId: ROLE_A, failedRoleId: ROLE_B }, EXAM, EXAM);
  assert.match(r.errors.join(' '), /maior que a pontuação máxima/);
  r = validateExamSettings({ autoApproval: true, passingScore: '7,5', approvedRoleId: ROLE_A, failedRoleId: ROLE_A }, EXAM, EXAM);
  assert.match(r.errors.join(' '), /diferentes/);
  r = validateExamSettings({ autoApproval: true, passingScore: '10', approvedRoleId: `<@&${ROLE_A}>`, failedRoleId: ROLE_B, resultChannelId: 'abc' }, EXAM, EXAM);
  assert.match(r.errors.join(' '), /canal de resultado/);
  r = validateExamSettings({ autoApproval: true, passingScore: '10', approvedRoleId: `<@&${ROLE_A}>`, failedRoleId: ROLE_B }, EXAM, EXAM);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.update, { autoApproval: true, passingScore: 10, approvedRoleId: ROLE_A, failedRoleId: ROLE_B });
  // Reduzir a prova depois: a mínima atual deixa de caber.
  r = validateExamSettings({}, { ...EXAM, autoApproval: true, passingScore: 8, approvedRoleId: ROLE_A, failedRoleId: ROLE_B }, { questionCount: 5, pointsPerQuestion: 1 });
  assert.match(r.errors.join(' '), /maior que a pontuação máxima/);
  assert.equal(maxPossibleScore({ questionCount: 50, pointsPerQuestion: 2 }), 100);
});

test('painel: grupo e slug validados; a prova "tcel" não troca de slug nem de grupo', () => {
  assert.match(validateExamSettings({ group: 'OUTRO' }, EXAM).errors.join(' '), /TCEL ou DAFP/);
  assert.match(validateExamSettings({ slug: 'Segundo Tenente' }, EXAM).errors.join(' '), /letras minúsculas/);
  assert.match(validateExamSettings({ slug: 'tcel' }, EXAM).errors.join(' '), /reservado/);
  const tcel = { name: 'Prova Tcel', slug: 'tcel', group: 'TCEL', questionCount: 50, pointsPerQuestion: 2 };
  assert.match(validateExamSettings({ group: 'DAFP' }, tcel).errors.join(' '), /continuar TCEL/);
  assert.match(validateExamSettings({ slug: 'outra' }, tcel).errors.join(' '), /não pode ser trocado/);
  assert.deepEqual(validateExamSettings({ group: 'TCEL', slug: 'tcel' }, tcel).errors, []);
  assert.deepEqual(validateExamSettings({ group: 'dafp', slug: 'major' }, { group: 'TCEL' }).update, { group: 'DAFP', slug: 'major' });
});
