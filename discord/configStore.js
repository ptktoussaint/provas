const DiscordConfig = require('../models/DiscordConfig');

// Cache curto só para responder rápido às interações (o Discord exige
// resposta em até 3 s, e abrir um formulário precisa ser a PRIMEIRA
// resposta). Qualquer gravação pelo admin invalida o cache na hora.
const TTL_MS = 15000;
let cache = null;
let cachedAt = 0;

function toPlain(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    panelChannelId: o.panelChannelId || null,
    resultsChannelId: o.resultsChannelId || null,
    operatorRoles: {
      generate: (o.operatorRoles && o.operatorRoles.generate) || [],
      results: (o.operatorRoles && o.operatorRoles.results) || [],
      promote: (o.operatorRoles && o.operatorRoles.promote) || [],
    },
    defaultExamId: o.defaultExamId ? String(o.defaultExamId) : null,
    promotion: {
      addRoleIds: (o.promotion && o.promotion.addRoleIds) || [],
      removeRoleIds: (o.promotion && o.promotion.removeRoleIds) || [],
      announceChannelId: (o.promotion && o.promotion.announceChannelId) || null,
      announceRoleId: (o.promotion && o.promotion.announceRoleId) || null,
      nicknameTemplate: (o.promotion && o.promotion.nicknameTemplate) || '',
    },
    panelMessage: {
      channelId: (o.panelMessage && o.panelMessage.channelId) || null,
      messageId: (o.panelMessage && o.panelMessage.messageId) || null,
    },
    lastError: o.lastError || null,
    lastErrorAt: o.lastErrorAt || null,
    updatedAt: o.updatedAt || null,
  };
}

async function getConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const doc = await DiscordConfig.getOrCreate();
  cache = toPlain(doc);
  cachedAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

async function saveConfig(update, actor) {
  const doc = await DiscordConfig.getOrCreate();
  doc.panelChannelId = update.panelChannelId;
  doc.resultsChannelId = update.resultsChannelId;
  doc.operatorRoles = update.operatorRoles;
  doc.defaultExamId = update.defaultExamId || null;
  doc.promotion = update.promotion;
  doc.updatedBy = actor;
  await doc.save();
  invalidate();
  return getConfig({ fresh: true });
}

async function setPanelMessage(channelId, messageId) {
  await DiscordConfig.updateOne({ singleton: 'main' }, { $set: { 'panelMessage.channelId': channelId, 'panelMessage.messageId': messageId } });
  invalidate();
}

async function recordError(message) {
  await DiscordConfig.updateOne({ singleton: 'main' }, { $set: { lastError: message, lastErrorAt: new Date() } }).catch(() => {});
  invalidate();
}

module.exports = { getConfig, invalidate, saveConfig, setPanelMessage, recordError, toPlain };
