const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Relatório de uso do banco: somente leitura, sem conteúdo de documentos.
let db;
before(async () => { db = await H.setupDb(); });
after(async () => { await db.teardown(); });

test('lista as coleções com contagem/tamanhos/datas, não mostra conteúdo e não altera nada', async () => {
  const { logSecurityEvent } = require('../lib/securityLog');
  const { logExamEvent } = require('../lib/eventLog');
  const { mongoose } = require('../config/db');
  const exam = await H.seedExam({ name: 'Prova Secreta XYZ' });
  const roomId = new mongoose.Types.ObjectId();
  for (let i = 0; i < 5; i += 1) await logExamEvent({ roomId, actor: 'student', type: 'answer_submitted', meta: { order: i } });
  await logSecurityEvent('admin_login_success', { meta: { username: 'Fulano Nome Pessoal' }, ip: '10.1.2.3' });

  const counts = async () => {
    const out = {};
    for (const c of await mongoose.connection.db.listCollections().toArray()) out[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
    return out;
  };
  const beforeCounts = await counts();
  const { buildStorageReport } = require('../lib/storageReport');
  const report = await buildStorageReport();
  assert.deepEqual(await counts(), beforeCounts, 'nada foi criado/alterado/apagado');

  const byName = Object.fromEntries(report.collections.map((c) => [c.name, c]));
  assert.equal(byName.examevents.count, 5);
  assert.equal(byName.examevents.dateField, 'at');
  assert.ok(byName.examevents.size > 0);
  assert.ok(byName.examevents.oldest && byName.examevents.newest);
  assert.equal(byName.examevents.months.length, 6);
  assert.equal(byName.examevents.months.at(-1).count, 5);
  assert.equal(byName.securitylogs.count, 1);
  assert.equal(byName.questions.count > 0, true);
  assert.ok(report.totals.used > 0);
  assert.equal(report.totals.limit, 512 * 1024 * 1024);

  const json = JSON.stringify(report);
  for (const secret of ['Fulano Nome Pessoal', '10.1.2.3', 'Prova Secreta XYZ', String(exam._id)]) {
    assert.ok(!json.includes(secret), `não expõe conteúdo: ${secret}`);
  }
});

test('estimativa de crescimento: amostra pequena marcada; ritmo por mês', () => {
  const { estimateGrowth } = require('../lib/storageReport');
  const now = new Date('2026-09-28T00:00:00Z');
  const small = estimateGrowth({ count: 10, avgObjSize: 100, indexSize: 0, oldest: new Date('2026-09-20T00:00:00Z'), newest: now, now });
  assert.equal(small.smallSample, true);
  assert.equal(small.docsPerMonth, 10, 'menos de 30 dias: conta como 1 mês, não extrapola');
  const big = estimateGrowth({ count: 600, avgObjSize: 1000, indexSize: 60000, oldest: new Date('2026-03-28T00:00:00Z'), newest: now, now });
  assert.equal(big.smallSample, false);
  assert.equal(big.docsPerMonth, 98);
  assert.equal(big.bytesPerMonth, Math.round((600 / 184) * 30 * 1100));
  assert.equal(estimateGrowth({ count: 0 }).docsPerMonth, null);
});
