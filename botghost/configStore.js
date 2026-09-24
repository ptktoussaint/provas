const IntegrationConfig = require('../models/IntegrationConfig');
const { isSnowflake, parseIdList } = require('../lib/discordIds');
const { validateTemplate } = require('./nickname');

// Configuração da integração (aba Integração BotGhost). Cache curto para
// as requisições do BotGhost responderem rápido; gravar invalida na hora.
const TTL_MS = 10000;
const MAX_ROLE_SLOTS = 5;
let cache = null;
let cachedAt = 0;

function toPlain(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  const ops = o.operatorIds || {};
  const ch = o.channels || {};
  const pr = o.promotion || {};
  return {
    operatorIds: { generate: ops.generate || [], results: ops.results || [], promote: ops.promote || [] },
    defaultExamId: o.defaultExamId ? String(o.defaultExamId) : null,
    channels: { panel: ch.panel || null, results: ch.results || null, test: ch.test || null },
    promotion: {
      addRoleIds: pr.addRoleIds || [],
      removeRoleIds: pr.removeRoleIds || [],
      announceChannelId: pr.announceChannelId || null,
      announceRoleId: pr.announceRoleId || null,
      nicknameTemplate: pr.nicknameTemplate || '',
    },
    panelMessage: {
      channelId: (o.panelMessage && o.panelMessage.channelId) || null,
      messageId: (o.panelMessage && o.panelMessage.messageId) || null,
      updatedAt: (o.panelMessage && o.panelMessage.updatedAt) || null,
    },
    status: o.status || {},
    updatedAt: o.updatedAt || null,
    updatedBy: o.updatedBy || null,
  };
}

async function getConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = toPlain(await IntegrationConfig.getOrCreate());
  cachedAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

function channel(value, label, errors, required = false) {
  const text = String(value == null ? '' : value).trim().replace(/^<#(\d+)>$/, '$1');
  if (!text) {
    if (required) errors.push(`${label}: obrigatório.`);
    return null;
  }
  if (!isSnowflake(text)) { errors.push(`${label}: ID inválido (use o ID numérico copiado do Discord).`); return null; }
  return text;
}

function ids(value, label, errors) {
  const { ids: list, invalid } = parseIdList(value);
  if (invalid.length) errors.push(`${label}: IDs inválidos (${invalid.slice(0, 3).join(', ')}).`);
  return list;
}

// Pura: devolve { update, errors }.
function validateConfig(body = {}) {
  const errors = [];
  const ops = body.operatorIds || {};
  const ch = body.channels || {};
  const pr = body.promotion || {};
  const update = {
    operatorIds: {
      generate: ids(ops.generate, 'Operadores que podem gerar provas', errors),
      results: ids(ops.results, 'Operadores que podem consultar notas', errors),
      promote: ids(ops.promote, 'Operadores que podem promover', errors),
    },
    defaultExamId: body.defaultExamId ? String(body.defaultExamId) : null,
    channels: {
      panel: channel(ch.panel, 'Canal do painel', errors),
      results: channel(ch.results, 'Canal de resultados', errors),
      test: channel(ch.test, 'Canal de teste', errors),
    },
    promotion: {
      addRoleIds: ids(pr.addRoleIds, 'Cargos a adicionar', errors),
      removeRoleIds: ids(pr.removeRoleIds, 'Cargos a remover', errors),
      announceChannelId: channel(pr.announceChannelId, 'Canal de anúncio de promoções', errors, true),
      announceRoleId: channel(pr.announceRoleId, 'Cargo mencionado no anúncio', errors, true),
      nicknameTemplate: String(pr.nicknameTemplate == null ? '' : pr.nicknameTemplate).trim(),
    },
  };
  if (update.defaultExamId && !/^[a-f0-9]{24}$/i.test(update.defaultExamId)) errors.push('Prova padrão inválida.');
  if (!update.promotion.addRoleIds.length) errors.push('Informe pelo menos um cargo a adicionar na promoção.');
  // Cada cargo vira um bloco fixo no BotGhost (addRole1..5 / removeRole1..5).
  if (update.promotion.addRoleIds.length > MAX_ROLE_SLOTS) errors.push(`No máximo ${MAX_ROLE_SLOTS} cargos a adicionar.`);
  if (update.promotion.removeRoleIds.length > MAX_ROLE_SLOTS) errors.push(`No máximo ${MAX_ROLE_SLOTS} cargos a remover.`);
  const overlap = update.promotion.addRoleIds.filter((id) => update.promotion.removeRoleIds.includes(id));
  if (overlap.length) errors.push(`O mesmo cargo não pode estar em "adicionar" e "remover" (${overlap.join(', ')}).`);
  const tplError = validateTemplate(update.promotion.nicknameTemplate);
  if (tplError) errors.push(tplError);
  return { update, errors };
}

async function saveConfig(update, actor) {
  const doc = await IntegrationConfig.getOrCreate();
  doc.operatorIds = update.operatorIds;
  doc.defaultExamId = update.defaultExamId || null;
  doc.channels = update.channels;
  doc.promotion = update.promotion;
  doc.updatedBy = actor;
  await doc.save();
  invalidate();
  return getConfig({ fresh: true });
}

async function setPanelMessage(channelId, messageId) {
  await IntegrationConfig.updateOne({ singleton: 'main' }, { $set: { 'panelMessage.channelId': channelId, 'panelMessage.messageId': messageId, 'panelMessage.updatedAt': new Date() } });
  invalidate();
}

// Indicadores da aba de integração. Gravados com folga (no máximo 1x a
// cada 30 s) para não pesar em cada requisição.
let lastStatusWrite = 0;
async function recordStatus(patch, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastStatusWrite < 30000) return;
  lastStatusWrite = now;
  const set = {};
  for (const [k, v] of Object.entries(patch)) set[`status.${k}`] = v;
  await IntegrationConfig.updateOne({ singleton: 'main' }, { $set: set }).catch(() => {});
  invalidate();
}

module.exports = { MAX_ROLE_SLOTS, getConfig, invalidate, validateConfig, saveConfig, setPanelMessage, recordStatus, toPlain };
