const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const Room = require('../models/Room');
const IntegrationConfig = require('../models/IntegrationConfig');
const { isSnowflake } = require('./discordIds');
const { logSecurityEvent } = require('./securityLog');

// Grupos de provas e regras de aprovação automática.
// - TCEL: fluxo antigo (/provas-tcel). A prova do comando é SEMPRE a de
//   slug "tcel" — nunca "a primeira/única/última" — para que criar outras
//   provas não mude o que o comando abre.
// - DAFP: novo fluxo (/provas-dafp). Só provas com group = 'DAFP' aparecem
//   e podem ser iniciadas por ele.

const GROUPS = ['TCEL', 'DAFP'];
const TCEL_SLUG = 'tcel';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 40;
const RESULT = { APPROVED: 'APROVADO', FAILED: 'REPROVADO', NOT_APPLICABLE: 'NAO_APLICAVEL' };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function slugify(text) {
  const s = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s || 'prova';
}

// Slug livre a partir de `base` ("capitao", "capitao-2", ...). "tcel" nunca é
// gerado automaticamente: só a migração ou o admin, explicitamente.
async function uniqueSlug(base, excludeId = null) {
  const root = slugify(base);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = i === 1 ? root : `${root.slice(0, SLUG_MAX - String(i).length - 1)}-${i}`;
    if (candidate === TCEL_SLUG) continue;
    const q = { slug: candidate };
    if (excludeId) q._id = { $ne: excludeId };
    if (!(await Exam.exists(q))) return candidate;
  }
  throw httpError(409, 'Não foi possível gerar um identificador único para a prova.');
}

function maxPossibleScore(exam) {
  return round2((Number(exam.questionCount) || 0) * (Number(exam.pointsPerQuestion) || 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'sim', '1', 'on', 'yes'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

function snowflakeField(value, label, errors, { required = false } = {}) {
  const text = String(value == null ? '' : value).trim().replace(/^<[@#]&?!?(\d+)>$/, '$1');
  if (!text) {
    if (required) errors.push(`${label}: obrigatório.`);
    return null;
  }
  if (!isSnowflake(text)) { errors.push(`${label}: ID inválido (use o ID numérico copiado do Discord).`); return null; }
  return text;
}

// Valida os campos de grupo/integração vindos do painel. `current` é a
// prova atual (ou {} na criação); `merged` já traz questionCount e
// pointsPerQuestion finais (para conferir a nota mínima). Pura.
function validateExamSettings(body, current = {}, merged = {}) {
  const errors = [];
  const update = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const isTcelExam = current.slug === TCEL_SLUG;

  if (has('group')) {
    const g = String(body.group || '').trim().toUpperCase();
    if (!GROUPS.includes(g)) errors.push('Grupo da prova: escolha TCEL ou DAFP.');
    else if (isTcelExam && g !== 'TCEL') errors.push('Esta é a prova fixa do /provas-tcel: o grupo dela precisa continuar TCEL.');
    else update.group = g;
  }

  if (has('slug')) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (isTcelExam && slug !== TCEL_SLUG) errors.push('O identificador "tcel" da prova do /provas-tcel não pode ser trocado.');
    else if (!slug) errors.push('Identificador (slug): obrigatório.');
    else if (slug.length > SLUG_MAX || !SLUG_RE.test(slug)) errors.push('Identificador (slug): use só letras minúsculas sem acento, números e hífen (ex.: segundo-tenente).');
    else update.slug = slug;
  }
  const finalGroup = update.group || current.group || 'TCEL';
  const finalSlug = update.slug || current.slug;
  if (finalSlug === TCEL_SLUG && finalGroup !== 'TCEL') errors.push('O identificador "tcel" é reservado para a prova do grupo TCEL.');

  const autoApproval = has('autoApproval') ? parseBool(body.autoApproval) : Boolean(current.autoApproval);
  if (has('autoApproval')) update.autoApproval = autoApproval;

  if (has('passingScore')) {
    const raw = body.passingScore;
    if (raw === null || raw === undefined || String(raw).trim() === '') update.passingScore = null;
    else {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) errors.push('Nota mínima: número maior ou igual a zero.');
      else if (Math.round(n * 100) !== n * 100) errors.push('Nota mínima: no máximo duas casas decimais.');
      else update.passingScore = n;
    }
  }
  if (has('approvedRoleId')) update.approvedRoleId = snowflakeField(body.approvedRoleId, 'ID do cargo de aprovado', errors);
  // Cargo de reprovado: LEGADO. Reprovado não recebe cargo; o valor antigo
  // pode continuar gravado (ou ser limpo), mas nenhum resultado novo o usa.
  if (has('failedRoleId')) update.failedRoleId = snowflakeField(body.failedRoleId, 'ID do cargo de reprovado (legado)', errors);
  if (has('resultChannelId')) update.resultChannelId = snowflakeField(body.resultChannelId, 'ID do canal de resultado', errors);

  if (autoApproval) {
    const passing = has('passingScore') ? update.passingScore : current.passingScore;
    const approved = has('approvedRoleId') ? update.approvedRoleId : current.approvedRoleId;
    if (passing == null && !errors.some((e) => e.startsWith('Nota mínima'))) errors.push('Nota mínima: obrigatória com aprovação automática.');
    if (!approved && !errors.some((e) => e.includes('aprovado'))) errors.push('ID do cargo de aprovado: obrigatório com aprovação automática.');
    const max = maxPossibleScore({ questionCount: merged.questionCount ?? current.questionCount, pointsPerQuestion: merged.pointsPerQuestion ?? current.pointsPerQuestion });
    if (passing != null && passing > max) errors.push(`Nota mínima (${passing}) maior que a pontuação máxima possível desta prova (${max} = questões × pontos por questão).`);
  }
  return { update, errors };
}

const FINISH_REASON = { manual: 'FINALIZADA_PELO_ALUNO', timeout: 'TEMPO_ESGOTADO', admin_closed: 'ENCERRADA_PELO_ADMIN' };

// Nota máxima atingida? Mesma precisão das notas do sistema (2 casas).
function isPerfectScore(score, maxScore) {
  const s = Number(score);
  const m = Number(maxScore);
  return Number.isFinite(s) && Number.isFinite(m) && m > 0 && round2(s) === round2(m);
}

// Decide aprovado/reprovado. Comparação direta com a nota da prova (em
// pontos, a mesma escala da nota): score >= passingScore. Sem porcentagem.
// Reprovado NÃO tem cargo (o antigo cargo de reprovado não é mais usado).
// DAFP encerrada pelo admin = cancelamento: sem aprovação e sem Mérito
// (só a Role base volta — ver roleActions).
function computeOutcome(exam, score, maxScore, { reason = 'manual', group = null, dafp = null, baseRoleRemovedId = null } = {}) {
  const isDafp = (group || (exam && exam.group)) === 'DAFP';
  const cancelled = isDafp && reason === 'admin_closed';
  const base = {
    decidedAt: new Date(),
    score,
    maxScore,
    examSlug: exam ? exam.slug || null : null,
    examName: exam ? exam.name : null,
    resultChannelId: exam ? exam.resultChannelId || null : null,
    approvedRoleId: null,
    failedRoleId: null,
    passingScore: null,
    autoApproval: false,
    resultStatus: RESULT.NOT_APPLICABLE,
    resultRoleId: null,
    perfectScore: !cancelled && isPerfectScore(score, maxScore),
    finishReason: FINISH_REASON[reason] || FINISH_REASON.manual,
    // A Role base devolvida é a mesma removida no início (se houve); senão
    // a configurada agora (adicionar quem já tem não muda nada).
    baseRoleId: isDafp ? (baseRoleRemovedId || (dafp && dafp.baseRoleId) || null) : null,
    perfectScoreRoleId: isDafp ? ((dafp && dafp.perfectScoreRoleId) || null) : null,
  };
  if (cancelled || !exam || !exam.autoApproval || exam.passingScore == null) return base;
  const passed = score >= exam.passingScore;
  return {
    ...base,
    autoApproval: true,
    passingScore: exam.passingScore,
    approvedRoleId: exam.approvedRoleId || null,
    resultStatus: passed ? RESULT.APPROVED : RESULT.FAILED,
    resultRoleId: passed ? exam.approvedRoleId || null : null,
  };
}

// ---- Ações de cargo do DAFP (o BotGhost executa; o site só decide) ----
// Três posições FIXAS: 1 = Role base, 2 = cargo de aprovado da prova,
// 3 = Mérito em Proficiência. Posição sem ação → enabled false.
const ROLE_SLOTS = 3;

function roleAction(type, roleId, memberDiscordId) {
  return roleId && memberDiscordId ? { action: type, roleId, memberDiscordId } : null;
}

// Início real da prova: tirar a Role base.
function startRoleActions(attempt) {
  return [roleAction('REMOVE', attempt.dafpBaseRoleRemovedId, attempt.discordUserId), null, null];
}

// Encerramento definitivo: Role base SEMPRE volta; aprovado e Mérito só
// com resultado corrigido (nunca em resultado excluído ou cancelado).
function finishRoleActions(attempt) {
  const o = attempt.outcome || {};
  const member = attempt.discordUserId;
  const baseRole = o.baseRoleId || attempt.dafpBaseRoleRemovedId || null;
  if (attempt.deletedAt) return [roleAction('ADD', baseRole, member), null, null];
  return [
    roleAction('ADD', baseRole, member),
    o.resultStatus === RESULT.APPROVED ? roleAction('ADD', o.resultRoleId, member) : null,
    o.perfectScore ? roleAction('ADD', o.perfectScoreRoleId, member) : null,
  ];
}

// Formato para o BotGhost: lista (roleActions) + campos fixos por posição.
function roleActionFields(slots = []) {
  const out = { roleActions: slots.filter(Boolean) };
  for (let i = 0; i < ROLE_SLOTS; i += 1) {
    const a = slots[i] || null;
    const n = i + 1;
    out[`roleAction${n}Enabled`] = a ? 'true' : 'false';
    out[`roleAction${n}Type`] = a ? a.action : '';
    out[`roleAction${n}RoleId`] = a ? a.roleId : '';
    out[`roleAction${n}MemberDiscordId`] = a ? a.memberDiscordId : '';
  }
  return out;
}

// Prova por ID (24 hex) ou slug. Nunca pelo nome exibido.
async function findExamByRef(ref) {
  const text = String(ref == null ? '' : ref).trim();
  if (!text) return null;
  if (/^[a-f0-9]{24}$/i.test(text) && mongoose.Types.ObjectId.isValid(text)) {
    const byId = await Exam.findById(text).lean();
    if (byId) return byId;
  }
  const slug = text.toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  return Exam.findOne({ slug }).lean();
}

// Migração idempotente (roda a cada início do site):
// 1. provas sem grupo → TCEL (antes desta versão toda prova era TCEL);
// 2. marca a prova do /provas-tcel com o slug fixo "tcel", se ninguém tem:
//    a "prova padrão" da aba Integração; senão a da sala mais recente criada
//    pelo Discord; senão a única prova do grupo TCEL. Se não der para saber
//    com segurança, não marca nada (o fluxo TCEL segue a regra antiga, só
//    entre provas TCEL) e o painel avisa;
// 3. provas sem slug ganham um a partir do nome.
async function migrateExamGroups({ log = console } = {}) {
  const grouped = await Exam.updateMany({ $or: [{ group: { $exists: false } }, { group: null }] }, { $set: { group: 'TCEL' } });
  let tcelAssigned = null;
  if (!(await Exam.exists({ slug: TCEL_SLUG }))) {
    let candidate = null;
    let reason = null;
    const config = await IntegrationConfig.findOne({ singleton: 'main' }).select('defaultExamId').lean();
    if (config && config.defaultExamId) {
      candidate = await Exam.findOne({ _id: config.defaultExamId, group: { $ne: 'DAFP' } }).lean();
      reason = 'prova padrão da aba Integração';
    }
    if (!candidate) {
      const room = await Room.findOne({ createdVia: 'discord', examGroup: { $in: [null, 'TCEL'] } }).sort({ createdAt: -1 }).select('examId').lean();
      if (room) {
        candidate = await Exam.findOne({ _id: room.examId, group: { $ne: 'DAFP' } }).lean();
        reason = 'sala mais recente criada pelo Discord';
      }
    }
    if (!candidate) {
      const tcel = await Exam.find({ group: { $ne: 'DAFP' } }).select('_id name slug').limit(2).lean();
      if (tcel.length === 1) { candidate = tcel[0]; reason = 'única prova do grupo TCEL'; }
    }
    if (candidate) {
      await Exam.updateOne({ _id: candidate._id }, { $set: { slug: TCEL_SLUG, group: 'TCEL' } });
      tcelAssigned = { examId: String(candidate._id), name: candidate.name, previousSlug: candidate.slug || null, reason };
      await logSecurityEvent('exam_tcel_slug_assigned', { meta: tcelAssigned }).catch(() => {});
      log.log(`[migracao] prova "${candidate.name}" marcada como TCEL fixa (${reason}).`);
    } else {
      log.warn('[migracao] nenhuma prova marcada como TCEL fixa: marque no painel (Provas & Questões → Integração / Resultado → identificador "tcel").');
    }
  }
  const withoutSlug = await Exam.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] }).select('_id name').lean();
  for (const e of withoutSlug) {
    const slug = await uniqueSlug(e.name, e._id);
    await Exam.updateOne({ _id: e._id, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] }, { $set: { slug } });
  }
  return { groupedCount: grouped.modifiedCount || 0, tcelAssigned, slugsCreated: withoutSlug.length };
}

module.exports = {
  GROUPS, TCEL_SLUG, SLUG_RE, RESULT, FINISH_REASON, ROLE_SLOTS, slugify, uniqueSlug, maxPossibleScore, parseBool,
  validateExamSettings, computeOutcome, isPerfectScore, startRoleActions, finishRoleActions, roleActionFields, findExamByRef, migrateExamGroups,
};
