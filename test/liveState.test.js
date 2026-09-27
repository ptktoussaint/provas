const test = require('node:test');
const assert = require('node:assert/strict');

// Salas com prova finalizada somem do painel admin (Dashboard/Monitoramento),
// mas o estado continua disponível para quem ainda está conectado.
function fresh() {
  delete require.cache[require.resolve('../lib/liveState')];
  return require('../lib/liveState');
}

test('sala em prova aparece no painel; ao finalizar some, mas o fiscal ainda vê o resumo', () => {
  const live = fresh();
  const events = [];
  live.on('change', (id) => events.push(id));
  live.patch('r1', { roomLabel: 'Sala 1', studentName: 'Aluno', studentOnline: true, attemptStatus: 'in_progress' });
  assert.equal(live.allSummaries().length, 1);
  assert.ok(live.visibleSummary('r1'));
  live.markFinished('r1');
  assert.equal(live.visibleSummary('r1'), null);
  assert.deepEqual(live.allSummaries(), []);
  assert.ok(live.summary('r1'), 'tela do fiscal continua com o resumo');
  assert.equal(events.at(-1), 'r1', 'avisa o painel para tirar a sala');
});

test('evento atrasado de socket (desconexão) não faz a sala finalizada voltar', () => {
  const live = fresh();
  live.patch('r2', { studentOnline: true });
  live.removeRoom('r2'); // sala encerrada pelo admin
  live.patch('r2', { studentOnline: false, streamStatus: 'interrupted' }); // recria a entrada
  assert.deepEqual(live.allSummaries(), []);
});

test('tentativa nova na mesma sala (resultado anterior excluído) volta a aparecer', () => {
  const live = fresh();
  live.patch('r3', { studentOnline: true });
  live.markFinished('r3');
  live.unmarkFinished('r3');
  assert.equal(live.allSummaries().length, 1);
});

test('status da tentativa finalizado também esconde (ex.: depois de reiniciar o site)', () => {
  const live = fresh();
  live.patch('r4', { attemptStatus: 'finished_timeout' });
  assert.equal(live.visibleSummary('r4'), null);
  live.patch('r5', { attemptStatus: 'in_progress' });
  assert.equal(live.allSummaries().length, 1);
});
