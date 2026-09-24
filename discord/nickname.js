// Apelido de promoção: modelo "『TCEL•B』{nome} | {idRP}". O Discord aceita
// no máximo 32 caracteres; se passar, pedimos para encurtar o nome — nunca
// cortamos em silêncio (cortar poderia comer o ID RP).
const MAX_NICKNAME = 32;
const NOME_MAX = 32;
const ID_RP_MAX = 16;
const ID_RP_RE = /^[A-Za-z0-9._-]+$/;

function nicknameLength(text) {
  // Conta em unidades UTF-16 (a medida mais restritiva) — um emoji conta 2.
  return String(text).length;
}

function validateTemplate(template) {
  const t = String(template || '');
  if (!t.includes('{nome}') || !t.includes('{idRP}')) return 'O modelo do apelido precisa conter {nome} e {idRP}.';
  if (/[\r\n]/.test(t)) return 'O modelo do apelido não pode ter quebra de linha.';
  const fixed = t.replace(/\{nome\}/g, '').replace(/\{idRP\}/g, '');
  if (nicknameLength(fixed) > MAX_NICKNAME - 2) return 'A parte fixa do modelo é longa demais para caber em 32 caracteres.';
  return null;
}

function normalizeNome(nome) {
  return String(nome == null ? '' : nome).replace(/\s+/g, ' ').trim();
}

function buildNickname(template, { nome, idRP }) {
  return String(template).replace(/\{nome\}/g, nome).replace(/\{idRP\}/g, idRP);
}

function validateRpInput({ nome, idRP, template }) {
  const errors = [];
  const cleanNome = normalizeNome(nome);
  const cleanId = String(idRP == null ? '' : idRP).trim();

  if (!cleanNome) errors.push('Informe o NOME RP.');
  else if (cleanNome.length > NOME_MAX) errors.push(`O NOME RP pode ter no máximo ${NOME_MAX} caracteres.`);
  // @, < e > poderiam formar menções/marcações; ` quebraria a formatação.
  if (/[@<>`\u0000-\u001f]/.test(cleanNome)) errors.push('O NOME RP não pode conter @, <, >, ` nem caracteres de controle.');

  if (!cleanId) errors.push('Informe o ID RP.');
  else if (cleanId.length > ID_RP_MAX) errors.push(`O ID RP pode ter no máximo ${ID_RP_MAX} caracteres.`);
  else if (!ID_RP_RE.test(cleanId)) errors.push('O ID RP só pode ter letras, números, ponto, hífen e sublinhado.');

  const templateError = validateTemplate(template);
  if (templateError) errors.push(templateError);

  let nickname = null;
  if (!errors.length) {
    nickname = buildNickname(template, { nome: cleanNome, idRP: cleanId });
    const len = nicknameLength(nickname);
    if (len > MAX_NICKNAME) {
      errors.push(`O apelido ficaria com ${len} caracteres ("${nickname}") e o Discord aceita no máximo ${MAX_NICKNAME}. Encurte o NOME RP em pelo menos ${len - MAX_NICKNAME} caractere(s).`);
      nickname = null;
    }
  }
  return { ok: errors.length === 0, errors, nome: cleanNome, idRP: cleanId, nickname };
}

module.exports = { validateRpInput, buildNickname, validateTemplate, nicknameLength, MAX_NICKNAME, NOME_MAX, ID_RP_MAX };
