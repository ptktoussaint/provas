const Exam = require('../models/Exam');
const { listForDiscord } = require('../lib/results');
const { baseContext, renderForApi } = require('./messages');
const { userText, plainText, fmtNumber, fmtDate, mention, promotionBadge } = require('./format');
const { ApiError, boolText } = require('./http');

// "Conferir resultados": sempre lê o Mongo na hora (nada em memória). A
// resposta é uma página — o histórico inteiro fica acessível por
// Anterior/Próxima, nunca cortado no limite de uma mensagem.

const SORTS = ['date-desc', 'date-asc', 'score-desc', 'score-asc'];

function parseDate(value, endOfDay) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) || String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new ApiError(400, 'invalid_field', 'Data inválida (use AAAA-MM-DD ou DD/MM/AAAA).');
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  // Horário de Brasília (UTC-3).
  const iso = `${y}-${mo}-${d}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'invalid_field', 'Data inválida.');
  return date;
}

function line(item, index, promotions) {
  const who = item.discordUserId ? mention(item.discordUserId) : '*não vinculado*';
  const score = item.oralScore != null
    ? `Prova (${fmtNumber(item.writtenScore)}) + Prova Oral (${fmtNumber(item.oralScore)}) = **${fmtNumber(item.effectiveScore)}**`
    : `**${fmtNumber(item.effectiveScore)}/${fmtNumber(item.maxScoreComputed)}**`;
  const exam = userText(item.examId && item.examId.name ? item.examId.name : '—', 40);
  const timeout = item.status === 'finished_timeout' ? ' · ⏱️ tempo esgotado' : '';
  const promo = item.discordUserId ? promotionBadge(promotions.get(item.discordUserId)) : '—';
  return `**${index}.** ${who} · ${userText(item.studentName, 40)} — ${score} · ${exam} · ${fmtDate(item.finishedAt)} · tentativa \`${String(item._id).slice(-6)}\`${timeout} · ${promo}`;
}

const PENDING = 'Pendente';

// Fiscal principal (escolhido no formulário do Discord) + demais fiscais
// que se conectaram. Resultados antigos sem fiscal do Discord: ID e menção
// vazios, só os nomes registrados — nunca o ID de outra pessoa por palpite.
function supervisorFields(item) {
  const id = item.supervisorDiscordId || '';
  const principalName = id ? (item.supervisorDisplayName || '') : '';
  const others = (item.proctorNames || []).filter((n) => n && n !== item.supervisorDisplayName);
  const lines = [];
  if (id) lines.push(`⭐ ${mention(id)} — ${userText(principalName || 'sem nome', 60)} (principal, escolhido no Discord)`);
  for (const n of others) lines.push(`• ${userText(n, 60)}`);
  return {
    supervisorDiscordId: id,
    supervisorDisplayName: id ? plainText(principalName, 80) : plainText(others.join(', '), 200),
    supervisorMention: id ? mention(id) : '',
    supervisorsText: lines.join('\n'),
  };
}

// Notas separadas. Prova = nota da prova escrita (pontos por questão ×
// acertos; ajustada pelo admin em resultados antigos). Oral = pontos
// lançados no admin, SEM teto; ausente = "Pendente", nunca zero. Total =
// prova + oral (soma simples, 2 casas, pode passar da máxima da prova) —
// só existe quando a oral foi lançada.
function scoreFields(item) {
  const oralPending = item.oralScore == null;
  const exam = fmtNumber(item.writtenScore);
  const oral = oralPending ? PENDING : fmtNumber(item.oralScore);
  const total = oralPending ? PENDING : fmtNumber(item.effectiveScore);
  return {
    examScore: exam,
    examMaxScore: fmtNumber(item.maxScoreComputed),
    oralScore: oral,
    oralPending: boolText(oralPending),
    totalScore: total,
    scoreText: `Prova: ${exam} | Prova oral: ${oral} | Total: ${total}`,
  };
}

// Campos da prova da página, com prefixo "result" (para o embed do
// BotGhost). Sempre presentes; vazios quando a página não tem exatamente
// uma prova — nunca herdados de outra página nem de quem clicou.
const SINGLE_KEYS = ['AttemptId', 'ExamName', 'FinishedAt', 'StudentDiscordId', 'StudentDisplayName', 'StudentMention', 'StudentAvatarUrl',
  'SupervisorDiscordId', 'SupervisorDisplayName', 'SupervisorMention', 'SupervisorsText',
  'ExamScore', 'ExamMaxScore', 'OralScore', 'OralPending', 'TotalScore', 'ScoreText'];

function singleFields(entry) {
  const out = { resultSingle: boolText(Boolean(entry)) };
  for (const k of SINGLE_KEYS) out[`result${k}`] = '';
  if (!entry) return out;
  const map = {
    AttemptId: entry.attemptId,
    ExamName: entry.examName ? plainText(entry.examName, 100) : '',
    FinishedAt: fmtDate(entry.finishedAt),
    StudentDiscordId: entry.discordUserId,
    StudentDisplayName: plainText(entry.studentName, 80),
    StudentMention: entry.discordUserId ? mention(entry.discordUserId) : '',
    StudentAvatarUrl: entry.studentAvatarUrl,
    SupervisorDiscordId: entry.supervisorDiscordId,
    SupervisorDisplayName: entry.supervisorDisplayName,
    SupervisorMention: entry.supervisorMention,
    SupervisorsText: entry.supervisorsText,
    ExamScore: entry.examScore,
    ExamMaxScore: entry.examMaxScore,
    OralScore: entry.oralScoreText,
    OralPending: entry.oralPending,
    TotalScore: entry.totalScore,
    ScoreText: entry.scoreText,
  };
  for (const k of SINGLE_KEYS) out[`result${k}`] = map[k] == null ? '' : String(map[k]);
  return out;
}

function itemView(item, promotions) {
  const sc = scoreFields(item);
  return {
    attemptId: String(item._id),
    discordUserId: item.discordUserId || '',
    studentName: item.studentName,
    examName: item.examId && item.examId.name ? item.examId.name : '',
    score: item.effectiveScore,
    maxScore: item.maxScoreComputed,
    writtenScore: item.writtenScore,
    oralScore: item.oralScore == null ? '' : item.oralScore,
    hasOral: boolText(item.oralScore != null),
    finishedAt: item.finishedAt,
    status: item.status,
    promotion: item.discordUserId ? promotionBadge(promotions.get(item.discordUserId)) : '',
    studentAvatarUrl: item.studentAvatarUrl || '',
    ...supervisorFields(item),
    examScore: sc.examScore,
    examMaxScore: sc.examMaxScore,
    oralScoreText: sc.oralScore,
    oralPending: sc.oralPending,
    totalScore: sc.totalScore,
    scoreText: sc.scoreText,
  };
}

async function search(actor, { studentDiscordId, examId, from, to, sort, page, pageSize }) {
  if (!SORTS.includes(sort)) throw new ApiError(400, 'invalid_field', `sort deve ser um de: ${SORTS.join(', ')}.`);
  const fromDate = parseDate(from, false);
  const toDate = parseDate(to, true);
  const filters = [];
  if (studentDiscordId) filters.push(`usuário ${mention(studentDiscordId)}`);
  if (examId) {
    const exam = await Exam.findById(examId).select('name').lean();
    filters.push(`prova ${exam ? userText(exam.name, 40) : 'desconhecida'}`);
  }
  if (fromDate) filters.push(`desde ${from}`);
  if (toDate) filters.push(`até ${to}`);
  const filterText = filters.length ? `Filtro: ${filters.join(' · ')}` : 'Todos os resultados não excluídos.';

  // Tenta a página pedida; se a mensagem passar do limite do Discord, usa
  // páginas menores (nunca corta uma linha no meio).
  let size = pageSize;
  for (;;) {
    const data = await listForDiscord({ guildId: actor.guildId, userId: studentDiscordId, examId, from: fromDate, to: toDate, sort, page, pageSize: size });
    const lines = data.items.map((item, i) => line(item, data.page * size + i + 1, data.promotions));
    const common = {
      total: String(data.total),
      page: String(data.page),
      pageNumber: String(data.page + 1),
      pages: String(data.pages),
      pageSize: String(size),
      hasPrevious: boolText(data.page > 0),
      hasNext: boolText(data.page < data.pages - 1),
      previousPage: String(Math.max(0, data.page - 1)),
      nextPage: String(Math.min(data.pages - 1, data.page + 1)),
      filterText,
      displayText: data.items.length ? `${filterText}\n\n${lines.join('\n')}\n\nPágina ${data.page + 1}/${data.pages}` : `Nenhum resultado encontrado. ${filterText}`,
      items: data.items.map((item) => itemView(item, data.promotions)),
    };
    Object.assign(common, singleFields(common.items.length === 1 ? common.items[0] : null));
    const ctx = { ...baseContext(actor), 'filtro.descricao': filterText };
    try {
      const msg = data.items.length
        ? await renderForApi('results_list', { ...ctx, 'lista.resultados': lines.join('\n'), 'pagina.atual': common.pageNumber, 'pagina.total': common.pages, 'resultados.total': common.total })
        : await renderForApi('results_empty', ctx);
      return { ...common, ...msg };
    } catch (err) {
      if (err.code === 'render_failed' && size > 1 && /caracteres/.test(err.data && err.data.errors)) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { search, SORTS, parseDate, scoreFields, supervisorFields };
