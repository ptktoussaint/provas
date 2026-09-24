const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Percorre os fluxos reais do bot (roteador + autorização + telas) com
// interações simuladas. Confere as regras da API do Discord que mais
// quebram na prática: formulário só como PRIMEIRA resposta, toda interação
// respondida, respostas privadas, limites de componentes/textos.

let db;
let M;
before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    Question: require('../models/Question'),
    Room: require('../models/Room'),
    Promotion: require('../models/Promotion'),
    configStore: require('../discord/configStore'),
    configValidation: require('../discord/configValidation'),
    lifecycle: require('../lib/examLifecycle'),
    router: require('../discord/router'),
    Worker: require('../discord/worker').DiscordWorker,
    handlers: {
      panel: require('../discord/handlers/panel'),
      generate: require('../discord/handlers/generate'),
      results: require('../discord/handlers/results'),
      promote: require('../discord/handlers/promote'),
    },
  };
});
after(async () => { await db.teardown(); });

let fake;
let route;
let ctx;

async function runQueue() {
  const worker = new M.Worker({ ctx, log: H.silentLog });
  worker.stopped = false;
  for (let i = 0; i < 10; i += 1) if (!(await worker.tick())) break;
}

beforeEach(async () => {
  await db.reset();
  fake = H.createFakeDiscord();
  const { update } = M.configValidation.validateDiscordConfig({
    panelChannelId: H.PANEL,
    resultsChannelId: H.RESULTS,
    operatorRoles: { generate: H.ROLE_OPS, results: H.ROLE_OPS, promote: H.ROLE_OPS },
    promotion: { addRoleIds: `${H.ADD1},${H.ADD2}`, removeRoleIds: H.REM, announceChannelId: H.ANNOUNCE, announceRoleId: H.ADD1, nicknameTemplate: '『TCEL•B』{nome} | {idRP}' },
  });
  await M.configStore.saveConfig(update, 'teste');
  ctx = {
    adapter: fake.adapter,
    guildId: H.GUILD,
    publicBaseUrl: 'https://provas.example.com',
    getConfig: (o) => M.configStore.getConfig(o),
    configStore: M.configStore,
    kickWorker: () => { runQueue().catch(() => {}); },
  };
  route = M.router.createRouter({
    handlers: {
      panel: M.handlers.panel.createPanelHandler(ctx),
      generate: M.handlers.generate.createGenerateHandler(ctx),
      results: M.handlers.results.createResultsHandler(ctx),
      promote: M.handlers.promote.createPromoteHandler(ctx),
    },
    getConfig: () => M.configStore.getConfig(),
    expectedGuildId: H.GUILD,
    log: H.silentLog,
  });
});

function json(x) {
  return x && typeof x.toJSON === 'function' ? x.toJSON() : x;
}

function serialize(p) {
  const data = typeof p === 'string' ? { content: p } : p;
  return {
    content: data.content || '',
    embeds: (data.embeds || []).map(json),
    components: (data.components || []).map(json),
    flags: data.flags,
    allowedMentions: data.allowedMentions,
  };
}

// Limites da API que o Discord recusa na hora.
function assertDiscordLimits(msg) {
  assert.ok(msg.content.length <= 2000);
  assert.ok(msg.components.length <= 5, 'no máximo 5 linhas de componentes');
  const ids = [];
  for (const row of msg.components) {
    assert.ok(row.components.length >= 1 && row.components.length <= 5);
    for (const c of row.components) {
      if (c.custom_id) { assert.ok(c.custom_id.length <= 100); ids.push(c.custom_id); }
      if (c.options) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25);
        for (const o of c.options) { assert.ok(o.label.length <= 100); assert.ok(!o.description || o.description.length <= 100); }
      }
      if (c.label) assert.ok(c.label.length <= 80);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'custom_id repetido na mesma mensagem');
  let total = 0;
  for (const e of msg.embeds) {
    if (e.description) { assert.ok(e.description.length <= 4096); total += e.description.length; }
    for (const f of e.fields || []) { assert.ok(f.value.length <= 1024); total += f.value.length + f.name.length; }
  }
  assert.ok(total <= 6000);
}

function interaction({ customId = null, commandName = null, values = [], fields = {}, userId = H.OPERATOR, roles = [H.ROLE_OPS], modal = false } = {}) {
  const it = {
    guildId: H.GUILD,
    channelId: H.PANEL,
    customId,
    commandName,
    values,
    user: { id: userId, username: 'op' },
    member: { roles, displayName: 'Operador Teste' },
    deferred: false,
    replied: false,
    last: null,
    modalShown: null,
    followUps: [],
    ephemeral: null,
    client: {
      channels: {
        fetch: async (id) => ({
          id,
          send: async (payload) => { const s = serialize(payload); assertDiscordLimits(s); it.panelSent = s; return { id: 'panel-msg-1' }; },
          messages: { edit: async (mid, payload) => { it.panelEdited = serialize(payload); return { id: mid }; } },
        }),
      },
    },
    isChatInputCommand: () => Boolean(commandName),
    isMessageComponent: () => Boolean(customId) && !modal,
    isFromMessage: () => true,
    fields: { getTextInputValue: (k) => fields[k] },
    async showModal(m) {
      if (this.deferred || this.replied) throw new Error('showModal precisa ser a primeira resposta');
      this.modalShown = m.toJSON();
      this.replied = true;
    },
    async deferReply(opts) {
      if (this.deferred || this.replied) throw new Error('já respondida');
      this.deferred = true;
      this.ephemeral = Boolean(opts && opts.flags);
    },
    async deferUpdate() {
      if (this.deferred || this.replied) throw new Error('já respondida');
      this.deferred = true;
    },
    async editReply(p) {
      if (!this.deferred) throw new Error('editReply sem defer');
      this.last = serialize(p);
      assertDiscordLimits(this.last);
    },
    async reply(p) {
      if (this.deferred || this.replied) throw new Error('já respondida');
      this.replied = true;
      this.last = serialize(p);
      this.ephemeral = Boolean(p.flags);
    },
    async update(p) {
      if (this.deferred || this.replied) throw new Error('já respondida');
      this.replied = true;
      this.last = serialize(p);
      assertDiscordLimits(this.last);
    },
    async followUp(p) { this.followUps.push(serialize(p)); },
  };
  return it;
}

async function click(opts) {
  const it = interaction(opts);
  await route(it);
  assert.ok(it.deferred || it.replied, `interação sem resposta: ${opts.customId || opts.commandName}`);
  assert.deepEqual(it.followUps.filter((f) => /Algo deu errado/.test(f.content)), [], `erro inesperado em ${opts.customId}`);
  return it;
}

function findComponent(msg, prefix) {
  for (const row of msg.components) for (const c of row.components) if (c.custom_id && c.custom_id.startsWith(prefix)) return c;
  return null;
}

async function seedExam(name = 'Prova TCEL') {
  const exam = await M.Exam.create({ name, questionCount: 5, pointsPerQuestion: 20, durationMinutes: 120 });
  for (let i = 0; i < 5; i += 1) {
    await M.Question.create({ examId: exam._id, text: `${name} q${i}`, options: ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: k })), correctKey: 'A' });
  }
  return exam;
}

test('fluxo /provatcel: publica uma vez e depois reaproveita a mesma mensagem', async () => {
  const first = await click({ commandName: 'provatcel' });
  assert.equal(first.ephemeral, true);
  assert.equal(first.panelSent.components[0].components.length, 3, 'exatamente três botões');
  assert.deepEqual(first.panelSent.components[0].components.map((b) => b.label), ['Gerar Prova', 'Conferir resultados', 'Promover']);
  const second = await click({ commandName: 'provatcel' });
  assert.ok(second.panelEdited, 'segunda vez edita o painel existente');
  assert.equal(second.panelSent, undefined);
});

test('fluxo Gerar Prova pelo Discord: formulário → confirmação → links só para o operador → clique repetido', async () => {
  await seedExam('Prova A');
  await seedExam('Prova B');
  const STUDENT = '700000000000000001';
  fake.addMember(STUDENT, { displayName: 'Soldado Ana' });

  const open = await click({ customId: 'ptc:gen' });
  assert.ok(open.modalShown, 'botão abre formulário como primeira resposta');
  assert.equal(open.modalShown.custom_id, 'ptc:g:m');

  const bot = '700000000000000555';
  fake.addMember(bot, { isBot: true });
  const botTry = await click({ customId: 'ptc:g:m', modal: true, fields: { uid: bot } });
  assert.match(botTry.last.content, /é um bot/);

  const submit = await click({ customId: 'ptc:g:m', modal: true, fields: { uid: `<@${STUDENT}>` } });
  assert.equal(submit.ephemeral, true);
  const examSelect = findComponent(submit.last, 'ptc:g:ex:');
  assert.ok(examSelect, 'duas provas ativas e sem padrão → escolha privada');
  assert.equal(findComponent(submit.last, 'ptc:g:ok:').disabled, true);
  assert.match(JSON.stringify(submit.last.embeds), /Soldado Ana/);

  const reqId = examSelect.custom_id.split(':')[3];
  const chosen = await click({ customId: examSelect.custom_id, values: [examSelect.options[0].value] });
  const okButton = findComponent(chosen.last, 'ptc:g:ok:');
  assert.equal(okButton.disabled, false);

  const nameBtn = findComponent(chosen.last, 'ptc:g:nm:');
  const nameModal = await click({ customId: nameBtn.custom_id });
  assert.ok(nameModal.modalShown);
  await click({ customId: `ptc:g:nmm:${reqId}`, modal: true, fields: { name: 'Ana Souza' } });

  const created = await click({ customId: okButton.custom_id });
  const fields = created.last.embeds[0].fields.map((f) => f.value).join('\n');
  assert.match(fields, /https:\/\/provas\.example\.com\/aluno\//);
  assert.match(fields, /https:\/\/provas\.example\.com\/professor\//);
  assert.match(fields, /Ana Souza/);
  assert.equal(await M.Room.countDocuments(), 1);

  const again = await click({ customId: okButton.custom_id });
  assert.match(again.last.content, /já foi processada/);
  assert.doesNotMatch(JSON.stringify(again.last), /\/aluno\//, 'links antigos nunca são reexibidos');
  assert.equal(await M.Room.countDocuments(), 1);

  // Outro operador (com cargo) não consegue mexer na solicitação alheia.
  const other = await click({ customId: okButton.custom_id, userId: '700000000000000777' });
  assert.match(other.followUps.concat(other.last ? [other.last] : []).map((m) => m.content).join(' '), /outro operador/);

  // Regenerar: pede confirmação explícita, depois gera links novos.
  const regen = await click({ customId: findComponent(created.last, 'ptc:g:rg:').custom_id });
  const confirm = findComponent(regen.last, 'ptc:g:rgok:');
  assert.ok(confirm);
  const done = await click({ customId: confirm.custom_id });
  assert.match(done.last.embeds[0].title, /Novos links/);
  const twice = await click({ customId: confirm.custom_id });
  assert.match(twice.last.content, /já foram trocados/);
});

test('fluxo Conferir resultados: lista paginada com filtros e Atualizar (dados atuais)', async () => {
  const exam = await seedExam();
  const Gen = require('../discord/generateService');
  for (let i = 0; i < 10; i += 1) {
    const uid = `70000000000000010${i}`;
    const req = await Gen.createRequest({ guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Op', targetUserId: uid, studentName: `Aluno ${i}`, examId: exam._id });
    const out = await Gen.confirmRequest(req._id, { guildId: H.GUILD, operatorId: H.OPERATOR, publicBaseUrl: ctx.publicBaseUrl });
    const { attempt } = await M.lifecycle.startOrResumeAttempt(out.room._id);
    attempt.snapshot.forEach((q, k) => { q.selectedKey = q.correctKey; q.isCorrect = k < (i % 5) + 1; });
    await attempt.save();
    await M.lifecycle.finalizeAttempt(attempt, 'manual');
  }

  const list = await click({ customId: 'ptc:res' });
  assert.equal(list.ephemeral, true);
  assert.match(list.last.embeds[0].title, /Resultados \(10\)/);
  assert.match(list.last.embeds[0].footer.text, /Página 1\/2/);

  const next = await click({ customId: findComponent(list.last, 'ptc:r:n:').custom_id });
  assert.match(next.last.embeds[0].footer.text, /Página 2\/2/);

  const sort = findComponent(list.last, 'ptc:r:s:');
  const sorted = await click({ customId: sort.custom_id, values: ['sd'] });
  assert.match(sorted.last.embeds[0].description, /\*\*100\/100\*\*/);

  const byUser = await click({ customId: findComponent(list.last, 'ptc:r:u:').custom_id, values: ['700000000000000103'] });
  assert.match(byUser.last.embeds[0].title, /Resultados \(1\)/);
  assert.match(byUser.last.embeds[0].description, /<@700000000000000103>/);

  // Atualizar busca dados atuais (uma nota ajustada aparece na hora).
  const results = require('../lib/results');
  const target = await require('../models/ExamAttempt').findOne({ discordUserId: '700000000000000103' });
  await results.adjustScore({ attemptId: target._id, score: 55, reason: 'teste', actor: 'admin:a' });
  const refreshed = await click({ customId: findComponent(byUser.last, 'ptc:r:f:').custom_id });
  assert.match(refreshed.last.embeds[0].description, /55\/100\*\* \(ajustada\)/);
});

test('fluxo Promover pelo Discord: seleção → dados RP (um formulário por vez) → revisão → confirmação → andamento', async () => {
  const exam = await seedExam();
  const Gen = require('../discord/generateService');
  const users = ['700000000000000201', '700000000000000202'];
  for (const uid of users) {
    fake.addMember(uid);
    const req = await Gen.createRequest({ guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Op', targetUserId: uid, studentName: `Aluno ${uid.slice(-1)}`, examId: exam._id });
    const out = await Gen.confirmRequest(req._id, { guildId: H.GUILD, operatorId: H.OPERATOR, publicBaseUrl: ctx.publicBaseUrl });
    const { attempt } = await M.lifecycle.startOrResumeAttempt(out.room._id);
    attempt.snapshot.forEach((q) => { q.selectedKey = q.correctKey; q.isCorrect = true; });
    await attempt.save();
    await M.lifecycle.finalizeAttempt(attempt, 'manual');
  }

  const start = await click({ customId: 'ptc:pro' });
  const select = findComponent(start.last, 'ptc:p:sel:');
  assert.equal(select.options.length, 2);
  const draftId = select.custom_id.split(':')[3];

  const picked = await click({ customId: select.custom_id, values: select.options.map((o) => o.value) });
  assert.match(picked.last.embeds[0].description, /Selecionados \(2\/25\)/);
  assert.equal(findComponent(picked.last, 'ptc:p:rv:').disabled, true, 'não revisa sem os dados RP');

  // Nome longo demais: recusado, sem cortar.
  const fill1 = await click({ customId: `ptc:p:rp:${draftId}` });
  assert.ok(fill1.modalShown);
  const firstUser = fill1.modalShown.custom_id.split(':')[4];
  assert.ok(users.includes(firstUser));
  assert.match(JSON.stringify(fill1.modalShown), new RegExp(firstUser), 'o formulário mostra o ID do Discord de quem está sendo preenchido');
  const tooLong = await click({ customId: fill1.modalShown.custom_id, modal: true, fields: { nome: 'Nome Muito Comprido Mesmo', idrp: '12345' } });
  assert.match(tooLong.last.content, /Encurte o NOME RP/);

  await click({ customId: fill1.modalShown.custom_id, modal: true, fields: { nome: 'Ana', idrp: '11' } });
  const fill2 = await click({ customId: `ptc:p:rp:${draftId}` });
  const secondUser = fill2.modalShown.custom_id.split(':')[4];
  assert.notEqual(secondUser, firstUser);
  const filled = await click({ customId: fill2.modalShown.custom_id, modal: true, fields: { nome: 'Bia', idrp: '22' } });
  assert.match(filled.last.content, /Todos preenchidos/);

  const review = await click({ customId: `ptc:p:rv:${draftId}` });
  assert.match(review.last.embeds[0].title, /Revisão final/);
  assert.match(review.last.embeds[0].description, /『TCEL•B』Ana \| 11/);
  const confirm = findComponent(review.last, 'ptc:p:ok:');
  assert.equal(confirm.disabled, false);
  assert.equal(fake.count('addRole'), 0, 'nada muda antes da confirmação');

  const done = await click({ customId: confirm.custom_id });
  assert.match(done.last.embeds[0].title, /Promoção concluída|em andamento/);
  await runQueue();
  assert.equal(await M.Promotion.countDocuments({ status: 'completed' }), 2);
  const status = await click({ customId: `ptc:p:st:${draftId}` });
  assert.match(status.last.embeds[0].title, /✅ Promoção concluída/);
  assert.match(status.last.embeds[0].description, /Anúncio: ✅ enviado/);

  const twice = await click({ customId: confirm.custom_id });
  assert.match(JSON.stringify(twice.last), /já foi confirmada|Promoção concluída/);
  assert.equal(await M.Promotion.countDocuments(), 2);
});

test('fluxo Promover: cancelar antes de confirmar não altera ninguém', async () => {
  const start = await click({ customId: 'ptc:pro' });
  const draftId = findComponent(start.last, 'ptc:p:x:').custom_id.split(':')[3];
  const cancel = await click({ customId: `ptc:p:x:${draftId}` });
  assert.match(cancel.last.content, /nenhum membro foi alterado/);
  assert.equal(fake.state.calls.length, 0);
});
