const crypto = require('crypto');
const IntegrationRequest = require('../models/IntegrationRequest');
const { ApiError } = require('./http');

// Idempotência das ações que mudam algo. O BotGhost manda uma chave
// estável por ação lógica — recomendado {interaction_id}, que é o mesmo
// durante toda a execução daquele clique/formulário. Mesma chave + mesmo
// conteúdo = mesma resposta (sem executar de novo); mesma chave + conteúdo
// diferente = conflito. A resposta guardada nunca tem links.

const KEY_RE = /^[A-Za-z0-9:_.-]{6,100}$/;

function canonicalHash(payload) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sorted(v[k]); return o; }, {});
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex');
}

function readKey(req) {
  const key = String((req.body && req.body.idempotencyKey) || req.get('idempotency-key') || '').trim();
  if (!key) throw new ApiError(400, 'idempotency_key_required', 'idempotencyKey obrigatório (use {interaction_id}).', { field: 'idempotencyKey' });
  if (!KEY_RE.test(key)) throw new ApiError(400, 'invalid_field', 'idempotencyKey inválido (6 a 100 caracteres: letras, números, : _ . -).', { field: 'idempotencyKey' });
  return key;
}

// run() devolve { status, code, message, data, replayData }. replayData é o
// que pode ser devolvido numa repetição (sem segredos/links).
// Pedido que ficou "processando" por mais que isto (ex.: o site reiniciou
// no meio) pode ser assumido por uma repetição. As próprias ações conferem
// o estado no banco (ex.: sala já aberta), então não duplicam nada.
const STALE_PROCESSING_MS = 2 * 60 * 1000;

async function idempotent({ req, route, actorDiscordId, payload, run }) {
  const key = readKey(req);
  const scopeKey = `${route}:${actorDiscordId}:${key}`;
  const payloadHash = canonicalHash(payload);
  try {
    await IntegrationRequest.create({ scopeKey, route, actorDiscordId, payloadHash });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
    const prev = await IntegrationRequest.findOne({ scopeKey }).lean();
    if (!prev) throw new ApiError(409, 'request_in_progress', 'Pedido em processamento; tente de novo em instantes.');
    if (prev.payloadHash !== payloadHash) throw new ApiError(409, 'idempotency_conflict', 'Esta chave de idempotência já foi usada com outro conteúdo.');
    if (prev.status !== 'done') {
      const stale = Date.now() - new Date(prev.createdAt).getTime() > STALE_PROCESSING_MS;
      const taken = stale && await IntegrationRequest.findOneAndUpdate(
        { scopeKey, status: 'processing', createdAt: prev.createdAt },
        { $set: { createdAt: new Date() } },
      );
      if (!taken) throw new ApiError(409, 'request_in_progress', 'Este mesmo pedido ainda está em processamento. Aguarde alguns segundos.');
      return execute(scopeKey, run);
    }
    const r = prev.response || {};
    return { status: prev.httpStatus || 200, code: r.code || 'replayed', message: r.message || 'Pedido já processado.', data: { ...(r.data || {}), replayed: 'true' } };
  }
  return execute(scopeKey, run);
}

async function execute(scopeKey, run) {
  try {
    const out = await run();
    await IntegrationRequest.updateOne({ scopeKey }, {
      $set: { status: 'done', httpStatus: out.status, response: { code: out.replayCode || out.code, message: out.replayMessage || out.message, data: out.replayData || {} } },
    });
    return out;
  } catch (err) {
    // Falhou sem concluir: libera a chave para uma nova tentativa.
    await IntegrationRequest.deleteOne({ scopeKey, status: 'processing' });
    throw err;
  }
}

module.exports = { idempotent, canonicalHash, STALE_PROCESSING_MS };
