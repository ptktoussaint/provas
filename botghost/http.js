const mongoose = require('mongoose');
const { isSnowflake, parseUserIdInput } = require('../lib/discordIds');

// Respostas da API de integração: sempre { ok, code, message, data }, com
// campos estáveis. O BotGhost só lê texto e número, então valores usados em
// blocos são strings/números planos (listas prontas em displayText).

class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// displayText sempre presente: o bloco do BotGhost pode mostrar direto
// {nome_do_pedido.data.displayText} sem precisar de condição.
function reply(res, status, code, message, data = {}) {
  const out = { ...data };
  if (out.displayText == null || out.displayText === '') out.displayText = message;
  res.status(status).json({ ok: status < 400, code, message, data: out });
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ApiError) return reply(res, err.status, err.code, err.message, err.data);
      if (err && err.status && err.status < 500) return reply(res, err.status, err.code || 'invalid_request', err.message, err.errors ? { errors: err.errors } : {});
      console.error('[botghost-api] erro interno:', err && err.message);
      return reply(res, 500, 'internal_error', 'Erro interno no site. Tente de novo; se continuar, avise o admin.');
    }
  };
}

// ---------------- Validação de entrada (esquema simples) ----------------

function field(src, name) {
  const v = src ? src[name] : undefined;
  return v === undefined || v === null ? '' : v;
}

// IDs do Discord como número no JSON já chegam arredondados (> 2^53):
// recusar em vez de aceitar outro ID.
function idField(src, name) {
  const v = field(src, name);
  if (typeof v === 'number') throw new ApiError(400, 'invalid_field', `${name} precisa ir entre aspas no JSON (texto), nunca como número.`, { field: name });
  return v;
}

function reqSnowflake(src, name, label = name) {
  const v = String(idField(src, name)).trim();
  if (!isSnowflake(v)) throw new ApiError(400, 'invalid_field', `${label}: ID do Discord inválido (texto com 17 a 20 dígitos).`, { field: name });
  return v;
}

function optSnowflake(src, name, label = name) {
  const v = String(idField(src, name)).trim();
  if (!v) return null;
  if (!isSnowflake(v)) throw new ApiError(400, 'invalid_field', `${label}: ID do Discord inválido.`, { field: name });
  return v;
}

function reqUserInput(src, name, label) {
  const id = parseUserIdInput(idField(src, name));
  if (!id) throw new ApiError(400, 'invalid_user', `${label}: informe o ID (17 a 20 dígitos) ou a menção <@ID>.`, { field: name });
  return id;
}

function optText(src, name, max = 100) {
  return String(field(src, name)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function reqText(src, name, label, max = 100) {
  const v = optText(src, name, max);
  if (!v) throw new ApiError(400, 'invalid_field', `${label}: obrigatório.`, { field: name });
  return v;
}

function optObjectId(src, name, label = name) {
  const v = String(field(src, name)).trim();
  if (!v) return null;
  if (!mongoose.Types.ObjectId.isValid(v) || !/^[a-f0-9]{24}$/i.test(v)) throw new ApiError(400, 'invalid_field', `${label}: identificador inválido.`, { field: name });
  return v;
}

function reqObjectId(value, label) {
  const v = String(value || '').trim();
  if (!/^[a-f0-9]{24}$/i.test(v)) throw new ApiError(400, 'invalid_field', `${label}: identificador inválido.`);
  return v;
}

function optInt(src, name, { min = 0, max = 1000, def = 0 } = {}) {
  const raw = field(src, name);
  if (raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'invalid_field', `${name}: número inteiro entre ${min} e ${max}.`, { field: name });
  return n;
}

// Aceita lista em array JSON ou texto separado por vírgula (o menu
// múltiplo do BotGhost devolve "id1,id2,id3").
function csvList(src, name, { max = 25, pattern = /^[A-Za-z0-9]{1,40}$/ } = {}) {
  const raw = field(src, name);
  if (typeof raw === 'number' || (Array.isArray(raw) && raw.some((x) => typeof x === 'number'))) {
    throw new ApiError(400, 'invalid_field', `${name}: IDs precisam ir como texto, nunca como número.`, { field: name });
  }
  let list = raw;
  // {selected_options} pode chegar como texto "a,b" ou como '["a","b"]'.
  if (!Array.isArray(list) && /^\s*\[/.test(String(list))) {
    try { list = JSON.parse(String(list)); } catch (_) { list = String(list).replace(/[[\]"']/g, ' '); }
    if (Array.isArray(list) && list.some((x) => typeof x === 'number')) {
      throw new ApiError(400, 'invalid_field', `${name}: IDs precisam ir como texto, nunca como número.`, { field: name });
    }
  }
  const items = (Array.isArray(list) ? list : String(list).split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  const unique = Array.from(new Set(items));
  if (unique.length > max) throw new ApiError(400, 'invalid_field', `${name}: no máximo ${max} itens.`);
  for (const i of unique) if (!pattern.test(i)) throw new ApiError(400, 'invalid_field', `${name}: item inválido.`);
  return unique;
}

function boolText(v) {
  return v ? 'true' : 'false';
}

module.exports = {
  ApiError, reply, wrap, reqSnowflake, optSnowflake, reqUserInput, optText, reqText, optObjectId, reqObjectId, optInt, csvList, boolText,
};
