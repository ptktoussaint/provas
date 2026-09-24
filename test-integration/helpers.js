// Infraestrutura dos testes de integração: MongoDB temporário em memória
// (mongodb-memory-server) e um "Discord falso" em memória com a mesma
// interface de discord/adapter.js. Nenhum teste chama a API real do Discord
// nem toca no banco de produção.
const { MongoMemoryServer } = require('mongodb-memory-server');

const GUILD = '900000000000000000';
const OWNER = '800000000000000000';
const OPERATOR = '700000000000000009';
const PANEL = '600000000000000001';
const RESULTS = '600000000000000002';
const ANNOUNCE = '1396947587235578017';
const ADD1 = '1231023397069258844';
const ADD2 = '1057349963203498105';
const REM = '1057349976482664569';
const ROLE_OPS = '500000000000000001';

async function setupDb() {
  const server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri('provas_test');
  process.env.SESSION_SECRET = 'test-secret';
  process.env.DISCORD_GUILD_ID = GUILD;
  const { connectDb, mongoose } = require('../config/db');
  const originalLog = console.log;
  console.log = () => {};
  await connectDb();
  console.log = originalLog;
  // Garante os índices únicos (clique repetido, promoção concorrente).
  for (const file of ['Room', 'ExamAttempt', 'Exam', 'Question', 'DiscordConfig', 'DiscordTask', 'DiscordRequest', 'PromotionDraft', 'Promotion', 'SecurityLog', 'ExamEvent']) {
    await require(`../models/${file}`).init();
  }
  return {
    mongoose,
    async reset() {
      const collections = await mongoose.connection.db.collections();
      await Promise.all(collections.map((c) => c.deleteMany({})));
      require('../discord/configStore').invalidate();
    },
    async teardown() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}

function createFakeDiscord() {
  const state = {
    ready: true,
    ownerId: OWNER,
    roles: {
      [ADD1]: { name: 'Promovido', position: 5, mentionable: true, managed: false },
      [ADD2]: { name: 'TCEL', position: 4, mentionable: false, managed: false },
      [REM]: { name: 'Recruta', position: 3, mentionable: false, managed: false },
    },
    members: new Map(),
    channels: new Map(),
    calls: [],
    failures: [],
    botHighest: 10,
    perms: { manageRoles: true, manageNicknames: true, administrator: false },
    announceChannel: { exists: true, name: 'promocoes', canView: true, canSend: true, canMentionEveryone: false },
    seq: 1,
  };

  function maybeFail(op, args) {
    const f = state.failures.find((x) => x.op === op && x.times > 0 && (!x.match || x.match(args)));
    if (!f) return;
    f.times -= 1;
    throw Object.assign(new Error(f.message || `${op} falhou`), f.error || {});
  }

  function highest(member) {
    return Math.max(member.basePosition || 0, ...member.roleIds.map((id) => (state.roles[id] ? state.roles[id].position : 0)));
  }

  const adapter = {
    isReady: () => state.ready,
    botUserId: () => 'bot',
    async sendMessage(channelId, payload) {
      state.calls.push({ op: 'send', channelId, payload });
      maybeFail('send', { channelId, payload });
      const list = state.channels.get(channelId) || [];
      // Mesmo comportamento do enforce_nonce do Discord.
      if (payload.enforceNonce && payload.nonce) {
        const existing = list.find((m) => m.nonce === payload.nonce);
        if (existing) return { id: existing.id, channelId };
      }
      const msg = { id: String(state.seq++), content: payload.content, nonce: payload.nonce, allowedMentions: payload.allowedMentions };
      list.push(msg);
      state.channels.set(channelId, list);
      return { id: msg.id, channelId };
    },
    async editMessage(channelId, messageId, payload) {
      state.calls.push({ op: 'edit', channelId, messageId, payload });
      maybeFail('edit', { channelId, messageId });
      const msg = (state.channels.get(channelId) || []).find((m) => m.id === messageId);
      if (!msg) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      msg.content = payload.content;
      return { id: msg.id, channelId };
    },
    async findRecentBotMessage(channelId, predicate) {
      const found = [...(state.channels.get(channelId) || [])].reverse().find((m) => predicate(m.content));
      return found ? { id: found.id } : null;
    },
    async fetchMember(guildId, userId) {
      const m = state.members.get(userId);
      if (!m) return null;
      return { id: userId, isBot: Boolean(m.isBot), displayName: m.displayName || `Membro ${userId.slice(-3)}`, nickname: m.nickname || null, roleIds: [...m.roleIds], highestPosition: highest(m), isOwner: userId === state.ownerId };
    },
    async addRole(guildId, userId, roleId) {
      state.calls.push({ op: 'addRole', userId, roleId });
      maybeFail('addRole', { userId, roleId });
      const m = state.members.get(userId);
      if (!m.roleIds.includes(roleId)) m.roleIds.push(roleId);
    },
    async removeRole(guildId, userId, roleId) {
      state.calls.push({ op: 'removeRole', userId, roleId });
      maybeFail('removeRole', { userId, roleId });
      const m = state.members.get(userId);
      m.roleIds = m.roleIds.filter((id) => id !== roleId);
    },
    async setNickname(guildId, userId, nickname) {
      state.calls.push({ op: 'setNickname', userId, nickname });
      maybeFail('setNickname', { userId, nickname });
      state.members.get(userId).nickname = nickname;
    },
    async guildSnapshot(guildId, { roleIds = [], announceChannelId = null } = {}) {
      const roles = {};
      for (const id of roleIds) {
        const r = state.roles[id];
        roles[id] = r ? { exists: true, ...r } : { exists: false };
      }
      return {
        id: GUILD,
        name: 'Servidor de teste',
        ownerId: state.ownerId,
        roles,
        bot: { highestPosition: state.botHighest, perms: { ...state.perms } },
        announceChannel: announceChannelId === ANNOUNCE ? { ...state.announceChannel } : { exists: false },
        channels: {},
      };
    },
  };

  return {
    state,
    adapter,
    addMember(userId, extra = {}) { state.members.set(userId, { roleIds: [REM], basePosition: 1, nickname: null, isBot: false, ...extra }); },
    count(op) { return state.calls.filter((c) => c.op === op).length; },
    messages(channelId) { return state.channels.get(channelId) || []; },
  };
}

const silentLog = { log() {}, warn() {}, error() {} };

module.exports = {
  setupDb, createFakeDiscord, silentLog,
  GUILD, OWNER, OPERATOR, PANEL, RESULTS, ANNOUNCE, ADD1, ADD2, REM, ROLE_OPS,
};
