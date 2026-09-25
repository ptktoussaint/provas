const Exam = require('../models/Exam');
const { listForDiscord } = require('../lib/results');
const { baseContext, renderForApi } = require('./messages');
const { userText, fmtNumber, fmtDate, mention, promotionBadge } = require('./format');
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
      items: data.items.map((item) => ({
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
        promotion: item.discordUserId ? promotionBadge(data.promotions.get(item.discordUserId)) : '',
      })),
    };
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

module.exports = { search, SORTS, parseDate };
