const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const Exam = require('../../models/Exam');
const { build } = require('../customIds');
const { deferPrivate, deferUpdate, updatePrivate } = require('../interactionUtils');
const { listForDiscord } = require('../../lib/results');
const { truncate, safeName, fmtNumber, unixSeconds, promotionBadge, LIMITS } = require('../format');
const { isSnowflake } = require('../../lib/discordIds');

const PAGE_SIZE = 8;
// Códigos curtos para caber no customId (limite de 100 caracteres).
const SORTS = {
  dd: { key: 'date-desc', label: 'Data (mais recente)' },
  da: { key: 'date-asc', label: 'Data (mais antiga)' },
  sd: { key: 'score-desc', label: 'Nota (maior primeiro)' },
  sa: { key: 'score-asc', label: 'Nota (menor primeiro)' },
};

// Todo o estado da tela vai no customId: página, ordenação, prova e
// usuário. Nada em memória — funciona igual depois de um reinício.
function stateFromParts(parts) {
  // parts: ['r', op, page, sort, exam, user]
  const page = Math.max(0, parseInt(parts[2], 10) || 0);
  const sort = SORTS[parts[3]] ? parts[3] : 'dd';
  const examId = parts[4] && /^[a-f0-9]{24}$/i.test(parts[4]) ? parts[4] : null;
  const userId = parts[5] && isSnowflake(parts[5]) ? parts[5] : null;
  return { page, sort, examId, userId };
}

function cid(op, s) {
  return build('r', op, s.page, s.sort, s.examId, s.userId);
}

function lineFor(item, index, promotions) {
  const who = item.discordUserId ? `<@${item.discordUserId}>` : '*não vinculado*';
  const name = safeName(item.studentName, 40);
  const score = `**${fmtNumber(item.effectiveScore)}/${fmtNumber(item.maxScoreComputed)}**${item.adjustedScore != null ? ' (ajustada)' : ''}`;
  const exam = safeName(item.examId && item.examId.name ? item.examId.name : '—', 40);
  const when = item.finishedAt ? `<t:${unixSeconds(item.finishedAt)}:f>` : '—';
  const promo = item.discordUserId ? promotionBadge(promotions.get(item.discordUserId)) : '—';
  const timeout = item.status === 'finished_timeout' ? ' · ⏱️ tempo esgotado' : '';
  return `**${index}.** ${who} · ${name} — ${score} · ${exam} · ${when} · tentativa \`${String(item._id).slice(-6)}\`${timeout} · ${promo}`;
}

async function render(state, guildId) {
  const [data, exams] = await Promise.all([
    listForDiscord({ guildId, userId: state.userId, examId: state.examId, sort: SORTS[state.sort].key, page: state.page, pageSize: PAGE_SIZE }),
    Exam.find().select('name active').sort({ createdAt: -1 }).limit(LIMITS.selectOptions - 1).lean(),
  ]);
  const s = { ...state, page: data.page };

  const lines = data.items.map((item, i) => lineFor(item, data.page * PAGE_SIZE + i + 1, data.promotions));
  const filters = [];
  if (s.userId) filters.push(`usuário <@${s.userId}>`);
  if (s.examId) {
    const exam = exams.find((e) => String(e._id) === s.examId);
    filters.push(`prova ${exam ? safeName(exam.name, 40) : s.examId}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle(`📊 Resultados (${data.total})`)
    .setDescription(truncate([
      filters.length ? `Filtro: ${filters.join(' · ')}` : 'Todos os resultados não excluídos.',
      '',
      lines.length ? lines.join('\n') : '_Nenhum resultado encontrado._',
    ].join('\n'), LIMITS.embedDescription))
    .setFooter({ text: `Página ${data.page + 1}/${data.pages} · ${SORTS[s.sort].label} · Fotografia de agora — use 🔄 Atualizar para ver mudanças.` })
    .setTimestamp(new Date());

  const examSelect = new StringSelectMenuBuilder()
    .setCustomId(cid('e', { ...s, page: 0 }))
    .setPlaceholder('Filtrar por prova')
    .addOptions([
      { label: 'Todas as provas', value: 'all', default: !s.examId },
      ...exams.map((e) => ({
        label: truncate(`${e.name}${e.active ? '' : ' (inativa)'}`, LIMITS.selectLabel),
        value: String(e._id),
        default: String(e._id) === s.examId,
      })),
    ]);

  const sortSelect = new StringSelectMenuBuilder()
    .setCustomId(cid('s', { ...s, page: 0 }))
    .setPlaceholder('Ordenar por')
    .addOptions(Object.entries(SORTS).map(([code, v]) => ({ label: v.label, value: code, default: code === s.sort })));

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(cid('u', { ...s, page: 0 }))
    .setPlaceholder('Buscar por usuário')
    .setMinValues(0)
    .setMaxValues(1);
  if (s.userId) userSelect.setDefaultUsers(s.userId);

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('p', { ...s, page: Math.max(0, s.page - 1) })).setLabel('◀ Anterior').setStyle(ButtonStyle.Secondary).setDisabled(s.page <= 0),
    new ButtonBuilder().setCustomId(cid('n', { ...s, page: s.page + 1 })).setLabel('Próxima ▶').setStyle(ButtonStyle.Secondary).setDisabled(s.page >= data.pages - 1),
    new ButtonBuilder().setCustomId(cid('f', s)).setLabel('🔄 Atualizar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('c', { ...s, page: 0, userId: null })).setLabel('Limpar usuário').setStyle(ButtonStyle.Secondary).setDisabled(!s.userId),
  );

  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(examSelect),
      new ActionRowBuilder().addComponents(sortSelect),
      new ActionRowBuilder().addComponents(userSelect),
      nav,
    ],
  };
}

function createResultsHandler(ctx) {
  return async function handleResults(interaction, parts) {
    if (parts[0] === 'res') {
      await deferPrivate(interaction);
      return updatePrivate(interaction, await render({ page: 0, sort: 'dd', examId: null, userId: null }, ctx.guildId));
    }

    await deferUpdate(interaction);
    const op = parts[1];
    const state = stateFromParts(parts);
    if (op === 'e') state.examId = interaction.values[0] === 'all' ? null : interaction.values[0];
    if (op === 's') state.sort = SORTS[interaction.values[0]] ? interaction.values[0] : 'dd';
    if (op === 'u') state.userId = interaction.values[0] || null;
    return updatePrivate(interaction, await render(state, ctx.guildId));
  };
}

module.exports = { createResultsHandler, stateFromParts, lineFor, SORTS };
