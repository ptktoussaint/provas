const MessageTemplate = require('../../models/MessageTemplate');
const { TEMPLATES, sampleContext } = require('./catalog');
const { normalizeSpec, validateSpec, renderTemplate } = require('./render');
const { logSecurityEvent } = require('../../lib/securityLog');

const MAX_VERSIONS = 20;

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function assertKey(key) {
  if (!TEMPLATES[key]) throw httpError(404, 'Modelo desconhecido.');
}

function defaultSpec(key) {
  return normalizeSpec(JSON.parse(JSON.stringify(TEMPLATES[key].default)));
}

// Modelo publicado (vale para as próximas mensagens). Sem publicação,
// vale o padrão TCEL do código.
async function getPublished(key) {
  assertKey(key);
  const doc = await MessageTemplate.findOne({ key }).select('published').lean();
  return doc && doc.published ? normalizeSpec(doc.published) : defaultSpec(key);
}

function publicMeta(key) {
  const d = TEMPLATES[key];
  return { key, label: d.label, visibility: d.visibility, help: d.help, placeholders: d.placeholders, pingTargets: d.pingTargets || [], allowsLinks: Boolean(d.allowsLinks), list: d.list || null };
}

async function listTemplates() {
  const docs = await MessageTemplate.find().select('key publishedVersion publishedAt publishedBy draftUpdatedAt').lean();
  const byKey = new Map(docs.map((d) => [d.key, d]));
  return Object.keys(TEMPLATES).map((key) => {
    const d = byKey.get(key);
    return {
      ...publicMeta(key),
      customized: Boolean(d && d.publishedVersion),
      publishedVersion: d ? d.publishedVersion : 0,
      publishedAt: d ? d.publishedAt : null,
      publishedBy: d ? d.publishedBy : null,
      hasDraft: Boolean(d && d.draftUpdatedAt && (!d.publishedAt || d.draftUpdatedAt > d.publishedAt)),
    };
  });
}

async function getEditorState(key) {
  assertKey(key);
  const doc = await MessageTemplate.findOne({ key }).lean();
  const published = doc && doc.published ? normalizeSpec(doc.published) : defaultSpec(key);
  return {
    ...publicMeta(key),
    draft: doc && doc.draft ? normalizeSpec(doc.draft) : published,
    published,
    defaultSpec: defaultSpec(key),
    publishedVersion: doc ? doc.publishedVersion : 0,
    publishedAt: doc ? doc.publishedAt : null,
    publishedBy: doc ? doc.publishedBy : null,
    draftUpdatedAt: doc ? doc.draftUpdatedAt : null,
    draftUpdatedBy: doc ? doc.draftUpdatedBy : null,
    versions: doc ? doc.versions.map((v) => ({ version: v.version, action: v.action, by: v.by, at: v.at })).reverse() : [],
  };
}

// Prévia sempre com dados FICTÍCIOS (nunca links nem pessoas reais).
function previewSpec(key, rawSpec) {
  assertKey(key);
  const errors = validateSpec(key, rawSpec);
  const rendered = renderTemplate(key, rawSpec, sampleContext(key), { mode: 'test' });
  return { errors: errors.concat(rendered.errors || []), message: rendered.message || null };
}

async function saveDraft(key, rawSpec, actor) {
  assertKey(key);
  const spec = normalizeSpec(rawSpec);
  await MessageTemplate.updateOne(
    { key },
    { $set: { draft: spec, draftUpdatedBy: actor, draftUpdatedAt: new Date() } },
    { upsert: true },
  );
  await logSecurityEvent('template_draft_saved', { meta: { key, by: actor } });
  return previewSpec(key, spec);
}

async function writePublished(key, spec, actor, action) {
  const doc = await MessageTemplate.findOneAndUpdate(
    { key },
    { $setOnInsert: { key } },
    { upsert: true, new: true },
  );
  const version = (doc.publishedVersion || 0) + 1;
  doc.published = spec;
  doc.draft = spec;
  doc.draftUpdatedAt = new Date();
  doc.draftUpdatedBy = actor;
  doc.publishedVersion = version;
  doc.publishedBy = actor;
  doc.publishedAt = new Date();
  doc.versions.push({ version, message: spec, action, by: actor });
  if (doc.versions.length > MAX_VERSIONS) doc.versions = doc.versions.slice(-MAX_VERSIONS);
  await doc.save();
  await logSecurityEvent(action === 'publish' ? 'template_published' : 'template_restored_default', { meta: { key, version, by: actor } });
  return version;
}

// Publicar exige modelo válido e que ele caiba nos limites com os dados de
// exemplo. Não republica mensagens antigas: vale para as próximas.
async function publish(key, rawSpec, actor) {
  assertKey(key);
  const spec = normalizeSpec(rawSpec);
  const { errors } = previewSpec(key, spec);
  if (errors.length) throw httpError(400, 'O modelo tem erros — corrija antes de publicar.', { errors });
  const version = await writePublished(key, spec, actor, 'publish');
  return { version };
}

async function restoreDefault(key, actor) {
  assertKey(key);
  const version = await writePublished(key, defaultSpec(key), actor, 'restore_default');
  return { version };
}

module.exports = { getPublished, listTemplates, getEditorState, previewSpec, saveDraft, publish, restoreDefault, defaultSpec };
