const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

// Nome da prova nas telas do aluno e do fiscal: sempre o da prova vinculada
// à sala (resolvido no servidor), nunca um nome global como "Prova TCEL".

let db;
let site;
let M;

before(async () => {
  db = await H.setupDb();
  M = { Exam: require('../models/Exam'), Room: require('../models/Room'), Settings: require('../models/Settings'), rooms: require('../lib/rooms') };
});
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.reset();
  site = await H.startSite();
  // Como em produção: o antigo "nome da plataforma" global.
  await M.Settings.create({ singleton: 'main', platformName: 'Prova TCEL' });
});
afterEach(async () => { await site.close(); });

const tokenOf = (link) => link.split('/').filter(Boolean).pop();

async function roomFor(examName, studentName) {
  const exam = await H.seedExam({ name: examName, questions: 3, points: 10 });
  const { room, studentLink } = await M.rooms.createRoom({ examId: exam._id, roomLabel: `Sala ${studentName}`, studentName, createdVia: 'admin' });
  const { proctorLink } = await M.rooms.addProctorLink(room._id, { label: 'Fiscal' });
  return { exam, room, studentToken: tokenOf(studentLink), proctorToken: tokenOf(proctorLink) };
}

test('duas salas simultâneas de provas diferentes: aluno e fiscal veem o nome da própria prova (e de novo ao recarregar)', async () => {
  const major = await roomFor('Prova Major', 'Aluno A');
  const capitao = await roomFor('Prova Capitão', 'Aluno B');
  const tcel = await roomFor('Prova TCEL', 'Aluno C');
  const cases = [[major, 'Prova Major'], [capitao, 'Prova Capitão'], [tcel, 'Prova TCEL']];

  for (let round = 0; round < 2; round += 1) { // 2ª volta = recarregar a página
    for (const [r, name] of cases) {
      const student = site.client();
      const s = await student('POST', '/api/student/identify', { studentToken: r.studentToken });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.equal(s.body.exam.name, name);
      assert.equal(s.body.finished, false);
      const proctor = site.client();
      const p = await proctor('POST', '/api/proctor/identify', { proctorToken: r.proctorToken });
      assert.equal(p.body.exam.name, name);
      const st = await proctor('GET', '/api/proctor/status');
      assert.equal(st.body.examName, name, 'acompanhamento do fiscal');
    }
  }
  // O navegador não escolhe o nome: campos extras são ignorados.
  const forged = await site.client()('POST', '/api/student/identify', { studentToken: major.studentToken, examName: 'Prova TCEL', examId: String(tcel.exam._id) });
  assert.equal(forged.body.exam.name, 'Prova Major');
});

test('link de prova finalizada: reabre direto na tela final com o nome certo (mesmo com a prova desativada depois)', async () => {
  const r = await roomFor('Prova Aspirante', 'Aluno D');
  const student = site.client();
  await student('POST', '/api/student/identify', { studentToken: r.studentToken });
  await H.takeExam(r.room._id, 2);
  const again = await site.client()('POST', '/api/student/identify', { studentToken: r.studentToken });
  assert.equal(again.status, 200);
  assert.equal(again.body.finished, true);
  assert.equal(again.body.exam.name, 'Prova Aspirante');
  const p = await site.client()('POST', '/api/proctor/identify', { proctorToken: r.proctorToken });
  assert.equal(p.body.exam.name, 'Prova Aspirante');

  await M.Exam.updateOne({ _id: r.exam._id }, { active: false });
  const inactive = await site.client()('POST', '/api/student/identify', { studentToken: r.studentToken });
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.finished, true);
  assert.equal(inactive.body.exam.name, 'Prova Aspirante');
  // Sala ainda não feita com a prova desativada continua bloqueada (regra antiga).
  const other = await roomFor('Prova 1º Tenente', 'Aluno E');
  await M.Exam.updateOne({ _id: other.exam._id }, { active: false });
  const blocked = await site.client()('POST', '/api/student/identify', { studentToken: other.studentToken });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.examName, 'Prova 1º Tenente');
});

test('sala antiga sem prova identificável: "Prova" como nome (nunca o nome global)', async () => {
  const r = await roomFor('Prova 2º Tenente', 'Aluno F');
  await M.Exam.deleteOne({ _id: r.exam._id });
  const s = await site.client()('POST', '/api/student/identify', { studentToken: r.studentToken });
  assert.equal(s.status, 409);
  assert.equal(s.body.examName, 'Prova');
  const p = await site.client()('POST', '/api/proctor/identify', { proctorToken: r.proctorToken });
  assert.equal(p.body.exam.name, 'Prova');
  // Nome em branco no cadastro também cai em "Prova".
  const { examDisplayName } = require('../lib/examIdentity');
  assert.equal(examDisplayName({ name: '   ' }), 'Prova');
  assert.equal(examDisplayName(null), 'Prova');
});

test('páginas: aluno/fiscal não usam o nome global; painel identificado como "Provas DAFP"', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');
  for (const page of ['student/index.html', 'proctor/index.html']) {
    const html = read(page);
    assert.match(html, /data-identity="exam"/, page);
    assert.ok(!/PROVAS LIVE|TCEL/.test(html), `${page} sem nome fixo`);
  }
  assert.match(read('student/client.js'), /applyExamIdentity\(data\.exam\.name\)/);
  assert.match(read('proctor/client.js'), /applyExamIdentity\(data\.exam && data\.exam\.name\)/);
  const admin = read('admin/index.html');
  assert.match(admin, /<title>Provas DAFP — Painel Administrativo<\/title>/);
  assert.match(admin, /data-identity="admin"/);
  assert.equal((admin.match(/<p class="logo-text">Provas DAFP<\/p>/g) || []).length, 2, 'login e criação do 1º admin');
  assert.match(admin, /<span>Provas DAFP<\/span> — Admin/);
  assert.ok(!/PROVAS LIVE|PROVA TCEL BOMBEIROS/.test(admin));
  // theme.js não sobrescreve páginas com identidade própria.
  assert.match(read('shared/theme.js'), /!document\.documentElement\.dataset\.identity/);
});
