const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { build } = require('../customIds');
const { deferPrivate, deferUpdate, updatePrivate, replyPrivate } = require('../interactionUtils');
const { truncate, safeName, fmtNumber, unixSeconds, LIMITS } = require('../format');
const { buildNickname } = require('../nickname');
const svc = require('../promotionService');

const STATUS_LABEL = {
  pending: '⏳ na fila',
  in_progress: '⏳ executando',
  completed: '✅ concluída',
  partial: '⚠️ parcial',
  failed: '❌ falhou',
};

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
}

function rpPreview(s, template) {
  if (!s.nomeRP || !s.idRP) return '⚠️ RP pendente';
  return `\`${buildNickname(template, { nome: s.nomeRP, idRP: s.idRP })}\``;
}

// ---------------- Tela 1: seleção + dados RP ----------------

async function selectView(draft, config, notice = null) {
  const cands = await svc.listCandidates(draft.guildId, { filterUserId: draft.filterUserId, page: draft.page });
  const selectedIds = new Set(draft.selections.map((s) => String(s.attemptId)));
  const template = config.promotion.nicknameTemplate;

  const selectedLines = draft.selections.map((s) => `• <@${s.discordUserId}> — ${safeName(s.studentName, 30)} — ${fmtNumber(s.scoreAtSelection)}/${fmtNumber(s.maxScore)} — ${safeName(s.examName || '—', 30)} — tentativa \`${String(s.attemptId).slice(-6)}\` — ${rpPreview(s, template)}`);

  const lockedNote = cands.locked.length
    ? `🔒 ${cands.locked.length} usuário(s) já promovido(s) por esta integração não aparecem na lista (histórico em **Conferir resultados**; liberação só pelo admin do site).`
    : null;

  const embed = new EmbedBuilder()
    .setColor(0x16a34a)
    .setTitle('🎖️ Promover — rascunho')
    .setDescription(truncate([
      '**1.** Marque na lista UM resultado por pessoa (as marcações das outras páginas são mantidas).',
      '**2.** Clique em **Preencher próximo** para informar NOME RP e ID RP de cada um.',
      '**3.** **Revisar e confirmar** — nada muda no Discord antes da confirmação final.',
      '',
      `**Selecionados (${draft.selections.length}/${svc.MAX_SELECTIONS}):**`,
      selectedLines.length ? selectedLines.join('\n') : '_ninguém ainda_',
      '',
      cands.filteredUserLocked ? `🔒 <@${draft.filterUserId}> já foi promovido(a) por esta integração.` : null,
      lockedNote,
      `Rascunho expira <t:${unixSeconds(draft.expiresAt)}:R> se ficar parado.`,
    ].filter((l) => l !== null).join('\n'), LIMITS.embedDescription))
    .setFooter({ text: `Resultados disponíveis: ${cands.total}${draft.filterUserId ? ' (filtrado por usuário)' : ''} · página ${cands.page + 1}/${cands.pages}` });

  const rows = [];
  if (cands.items.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(build('p', 'sel', draft._id, cands.page))
      .setPlaceholder('Marque os resultados desta página')
      .setMinValues(0)
      .setMaxValues(cands.items.length)
      .addOptions(cands.items.map((c) => ({
        label: truncate(`${c.studentName} — ${fmtNumber(c.effectiveScore)}/${fmtNumber(c.maxScoreComputed)} — ${c.examId && c.examId.name ? c.examId.name : '—'}`, LIMITS.selectLabel),
        description: truncate(`ID ${c.discordUserId} · ${fmtDate(c.finishedAt)} · tentativa ${String(c._id).slice(-6)}${c.adjustedScore != null ? ' · nota ajustada' : ''}`, LIMITS.selectDescription),
        value: String(c._id),
        default: selectedIds.has(String(c._id)),
      })))));
  }

  const filter = new UserSelectMenuBuilder().setCustomId(build('p', 'flt', draft._id)).setPlaceholder('Buscar usuário na lista').setMinValues(0).setMaxValues(1);
  if (draft.filterUserId) filter.setDefaultUsers(draft.filterUserId);
  rows.push(new ActionRowBuilder().addComponents(filter));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(build('p', 'pg', draft._id, Math.max(0, cands.page - 1))).setLabel('◀ Página').setStyle(ButtonStyle.Secondary).setDisabled(cands.page <= 0),
    new ButtonBuilder().setCustomId(build('p', 'pg', draft._id, cands.page + 1)).setLabel('Página ▶').setStyle(ButtonStyle.Secondary).setDisabled(cands.page >= cands.pages - 1),
    new ButtonBuilder().setCustomId(build('p', 'fltc', draft._id)).setLabel('Limpar busca').setStyle(ButtonStyle.Secondary).setDisabled(!draft.filterUserId),
  ));

  const unfilled = svc.nextUnfilled(draft);
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(build('p', 'rp', draft._id)).setLabel(unfilled ? 'Preencher próximo' : 'Todos preenchidos').setStyle(ButtonStyle.Primary).setDisabled(!unfilled),
    new ButtonBuilder().setCustomId(build('p', 'rv', draft._id)).setLabel('Revisar e confirmar').setStyle(ButtonStyle.Success).setDisabled(!draft.selections.length || Boolean(unfilled)),
    new ButtonBuilder().setCustomId(build('p', 'x', draft._id)).setLabel('Cancelar rascunho').setStyle(ButtonStyle.Danger),
  ));

  if (draft.selections.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(build('p', 'ed', draft._id))
      .setPlaceholder('Editar NOME RP / ID RP de...')
      .addOptions(draft.selections.map((s) => ({
        label: truncate(`${s.studentName} (${s.discordUserId})`, LIMITS.selectLabel),
        description: truncate(s.nomeRP ? `${s.nomeRP} | ${s.idRP}` : 'RP pendente', LIMITS.selectDescription),
        value: s.discordUserId,
      })))));
  }

  return { content: notice || draft.notice || '', embeds: [embed], components: rows };
}

// O modal mostra sempre o ID do Discord de quem está sendo preenchido, e o
// próprio ID do formulário carrega esse usuário — impossível gravar os
// dados RP de uma pessoa na outra.
function rpModal(draft, selection) {
  return new ModalBuilder()
    .setCustomId(build('p', 'rpm', draft._id, selection.discordUserId))
    .setTitle(truncate(`RP de ${selection.studentName}`, LIMITS.modalTitle))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('NOME RP')
        .setDescription(truncate(`Discord ID ${selection.discordUserId} — ${selection.studentName}`, LIMITS.labelDescription))
        .setTextInputComponent(new TextInputBuilder().setCustomId('nome').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32).setValue(selection.nomeRP || '')),
      new LabelBuilder()
        .setLabel('ID RP (do personagem)')
        .setDescription('Não é o ID do Discord. Letras, números, ponto, hífen ou sublinhado.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('idrp').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue(selection.idRP || '')),
    );
}

// ---------------- Tela 2: revisão final ----------------

function reviewView(draft, config, notice = null) {
  const review = draft.review || { entries: [], globalErrors: [], globalWarnings: [] };
  const promo = config.promotion;
  const rolesLine = [
    ...promo.addRoleIds.map((id) => `+<@&${id}>`),
    ...promo.removeRoleIds.map((id) => `−<@&${id}>`),
  ].join(' ');

  const lines = review.entries.map((e) => {
    const parts = [`• <@${e.userId}> → ${e.nickname ? `\`${e.nickname}\`` : '—'} · nota ${fmtNumber(e.score)}/${fmtNumber(e.maxScore)}`];
    if (e.plan) {
      const same = !e.plan.add.length && !e.plan.remove.length;
      parts.push(same ? 'cargos já em ordem' : `cargos: ${[...e.plan.add.map((id) => `+<@&${id}>`), ...e.plan.remove.map((id) => `−<@&${id}>`)].join(' ')}`);
    }
    if (e.preexisting) parts.push('sem anúncio');
    let text = parts.join(' · ');
    for (const w of e.warnings) text += `\n  ⚠️ ${w}`;
    for (const err of e.errors) text += `\n  ⛔ ${err}`;
    return text;
  });

  const announced = review.entries.filter((e) => !e.preexisting && !e.errors.length).length;
  const embed = new EmbedBuilder()
    .setColor(review.ok ? 0x16a34a : 0xdc2626)
    .setTitle(review.ok ? '🔎 Revisão final — confira antes de confirmar' : '⛔ Revisão — há problemas a resolver')
    // Bloqueios gerais primeiro: se o texto passar do limite do Discord, o
    // que é cortado é o fim da lista de pessoas, nunca o motivo do bloqueio.
    .setDescription(truncate([
      ...review.globalErrors.map((e) => `⛔ ${e}`),
      ...review.globalWarnings.map((w) => `⚠️ ${w}`),
      `Para cada pessoa: ${rolesLine} e apelido novo (demais cargos são mantidos).`,
      `Anúncio em <#${promo.announceChannelId}>: ${announced} pessoa(s), só depois de concluídas com sucesso.`,
      '',
      ...lines,
    ].join('\n'), LIMITS.embedDescription))
    .setFooter({ text: 'Cancelar ou sair daqui não altera ninguém. Os dados serão conferidos de novo ao confirmar.' });

  return {
    content: notice || draft.notice || '',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(build('p', 'ok', draft._id, draft.reviewHash)).setLabel('Confirmar promoção').setStyle(ButtonStyle.Success).setDisabled(!review.ok || !draft.reviewHash),
      new ButtonBuilder().setCustomId(build('p', 'bk', draft._id)).setLabel('Voltar e editar').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(build('p', 'x', draft._id)).setLabel('Cancelar rascunho').setStyle(ButtonStyle.Danger),
    )],
  };
}

// ---------------- Tela 3: andamento ----------------

function statusView(draft, progress, notice = null) {
  const lines = progress.promotions.map((p) => {
    let line = `• <@${p.discordUserId}> \`${p.nickname}\` — ${STATUS_LABEL[p.status] || p.status}`;
    if (p.preexisting) line += ' · sem anúncio (já tinha os cargos)';
    if (p.announced) line += ' · anunciado';
    const failed = p.steps.filter((s) => s.status === 'failed');
    if (failed.length) line += `\n  ❌ ${truncate(failed.map((s) => s.error).filter(Boolean).join(' | '), 300)}`;
    const pendingSteps = p.steps.filter((s) => s.status === 'pending').length;
    if (['partial', 'failed'].includes(p.status) && pendingSteps + failed.length) line += `\n  ↻ ${failed.length + pendingSteps} etapa(s) podem ser retomadas`;
    return line;
  });
  const announceLines = progress.announces.map((t) => `Anúncio: ${t.status === 'done' ? '✅ enviado' : t.status === 'failed' ? `❌ falhou — ${truncate(t.lastError || '', 200)} (o admin pode reprocessar só o anúncio)` : '⏳ na fila'}`);
  const canResume = progress.promotions.some((p) => ['partial', 'failed'].includes(p.status));

  const embed = new EmbedBuilder()
    .setColor(progress.done ? (canResume ? 0xf59e0b : 0x16a34a) : 0x2563eb)
    .setTitle(progress.done ? (canResume ? '⚠️ Promoção concluída com pendências' : '✅ Promoção concluída') : '⏳ Promoção em andamento')
    .setDescription(truncate([...lines, '', ...announceLines].join('\n'), LIMITS.embedDescription))
    .setFooter({ text: 'Fotografia de agora — clique em Atualizar para ver o estado atual.' })
    .setTimestamp(new Date());

  const buttons = [
    new ButtonBuilder().setCustomId(build('p', 'st', draft._id)).setLabel('🔄 Atualizar').setStyle(ButtonStyle.Primary),
  ];
  if (canResume) buttons.push(new ButtonBuilder().setCustomId(build('p', 'rs', draft._id)).setLabel('Retomar etapas pendentes').setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder().setCustomId(build('p', 'new', draft._id)).setLabel('Novo rascunho').setStyle(ButtonStyle.Secondary));

  return { content: notice || '', embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)] };
}

// ---------------- Roteamento ----------------

function createPromoteHandler(ctx) {
  const scope = (interaction) => ({ guildId: ctx.guildId, operatorId: interaction.user.id });

  async function renderDraft(interaction, draft, notice) {
    const config = await ctx.getConfig();
    if (['cancelled', 'expired'].includes(draft.status)) {
      return updatePrivate(interaction, { content: `${notice || draft.notice || 'Este rascunho foi encerrado.'}\nClique em **Promover** no painel para começar outro. Nenhum membro foi alterado.` });
    }
    if (['executing', 'completed', 'partial'].includes(draft.status)) {
      return updatePrivate(interaction, statusView(draft, await svc.draftProgress(draft._id), notice));
    }
    if (draft.status === 'review') return updatePrivate(interaction, reviewView(draft, config, notice));
    return updatePrivate(interaction, await selectView(draft, config, notice));
  }

  return async function handlePromote(interaction, parts) {
    const [head, op, draftId, arg] = parts;

    if (head === 'pro') {
      await deferPrivate(interaction);
      const draft = await svc.getOrCreateDraft(ctx.guildId, interaction.user.id);
      return renderDraft(interaction, draft);
    }

    // Abrir formulário precisa ser a PRIMEIRA resposta (sem defer antes).
    if (op === 'rp' || op === 'ed') {
      const draft = await svc.loadDraft(draftId, scope(interaction), { editable: true });
      const selection = op === 'ed'
        ? draft.selections.find((s) => s.discordUserId === interaction.values[0])
        : svc.nextUnfilled(draft);
      if (!selection) return replyPrivate(interaction, op === 'ed' ? 'Essa pessoa não está mais no lote.' : 'Todos já foram preenchidos. Use "Editar NOME RP / ID RP de..." para corrigir alguém.');
      return interaction.showModal(rpModal(draft, selection));
    }

    await deferUpdate(interaction);

    if (op === 'rpm') {
      const draft = await svc.loadDraft(draftId, scope(interaction), { editable: true });
      const config = await ctx.getConfig({ fresh: true });
      const out = await svc.setRpData(draft, arg, {
        nome: interaction.fields.getTextInputValue('nome'),
        idRP: interaction.fields.getTextInputValue('idrp'),
      }, config.promotion.nicknameTemplate);
      const notice = out.ok
        ? `✅ Dados RP salvos para <@${arg}> → \`${out.nickname}\`.${svc.nextUnfilled(draft) ? ' Clique em **Preencher próximo**.' : ' Todos preenchidos — clique em **Revisar e confirmar**.'}`
        : `⚠️ Não salvei os dados de <@${arg}>:\n${out.errors.map((e) => `• ${e}`).join('\n')}`;
      draft.notice = null;
      return updatePrivate(interaction, await selectView(draft, config, notice));
    }

    if (op === 'sel') {
      const draft = await svc.loadDraft(draftId, scope(interaction), { editable: true });
      const cands = await svc.listCandidates(draft.guildId, { filterUserId: draft.filterUserId, page: parseInt(arg, 10) || 0 });
      const out = svc.applySelection(draft.selections.map((s) => (s.toObject ? s.toObject() : s)), { pageCandidates: cands.items, chosenIds: interaction.values });
      if (out.error) return renderDraft(interaction, draft, `⚠️ ${out.error}`);
      draft.notice = null;
      await svc.saveSelections(draft, out.selections);
      return renderDraft(interaction, draft);
    }

    if (op === 'pg' || op === 'flt' || op === 'fltc' || op === 'bk') {
      const draft = await svc.loadDraft(draftId, scope(interaction), { editable: true });
      if (op === 'pg') draft.page = Math.max(0, parseInt(arg, 10) || 0);
      if (op === 'flt') { draft.filterUserId = interaction.values[0] || null; draft.page = 0; }
      if (op === 'fltc') { draft.filterUserId = null; draft.page = 0; }
      if (op === 'bk') { draft.status = 'draft'; draft.reviewHash = null; }
      draft.notice = null;
      await draft.save();
      return renderDraft(interaction, draft);
    }

    if (op === 'rv') {
      const draft = await svc.loadDraft(draftId, scope(interaction), { editable: true });
      if (!draft.selections.length) return renderDraft(interaction, draft, '⚠️ Selecione pelo menos uma pessoa.');
      if (svc.nextUnfilled(draft)) return renderDraft(interaction, draft, '⚠️ Preencha NOME RP e ID RP de todos antes de revisar.');
      draft.notice = null;
      await svc.reviewDraft(draft, ctx);
      return renderDraft(interaction, draft);
    }

    if (op === 'ok') {
      const out = await svc.confirmDraft(draftId, scope(interaction), arg, ctx);
      if (out.kind === 'started') {
        if (!out.created.length) return renderDraft(interaction, out.draft);
        const progress = await svc.waitForDraft(out.draft._id);
        const skipped = out.skipped.length ? `⚠️ Não promovidos (já promovidos por outra operação): ${out.skipped.map((id) => `<@${id}>`).join(', ')}` : null;
        return updatePrivate(interaction, statusView(out.draft, progress, skipped));
      }
      if (out.kind === 'already') return renderDraft(interaction, out.draft, 'Esta promoção já foi confirmada (clique repetido) — nada foi executado de novo.');
      if (out.kind === 'changed') return renderDraft(interaction, out.draft);
      if (out.draft) return renderDraft(interaction, out.draft, '⚠️ Esta revisão não é mais a atual. Confira a revisão abaixo.');
      return updatePrivate(interaction, { content: 'Rascunho não encontrado.' });
    }

    if (op === 'x') {
      await svc.cancelDraft(draftId, scope(interaction));
      return updatePrivate(interaction, { content: 'Rascunho cancelado — nenhum membro foi alterado.' });
    }

    if (op === 'new') {
      const old = await svc.loadDraft(draftId, scope(interaction)).catch(() => null);
      if (old && ['draft', 'review'].includes(old.status)) { old.status = 'cancelled'; await old.save(); }
      const draft = await svc.getOrCreateDraft(ctx.guildId, interaction.user.id);
      return renderDraft(interaction, draft);
    }

    if (op === 'st') {
      const draft = await svc.loadDraft(draftId, scope(interaction));
      return renderDraft(interaction, draft);
    }

    if (op === 'rs') {
      const draft = await svc.loadDraft(draftId, scope(interaction));
      const results = await svc.resumeDraft(draft._id, scope(interaction), `discord:${interaction.user.id}`);
      if (ctx.kickWorker) ctx.kickWorker();
      const locked = results.filter((r) => r.kind === 'locked').map((r) => `<@${r.promo.discordUserId}>`);
      const progress = await svc.waitForDraft(draft._id);
      const fresh = await svc.loadDraft(draftId, scope(interaction));
      return updatePrivate(interaction, statusView(fresh, progress, locked.length ? `⚠️ Não retomados (já promovidos por outra operação): ${locked.join(', ')}` : '↻ Retomada solicitada — só as etapas pendentes são refeitas.'));
    }

    return undefined;
  };
}

module.exports = { createPromoteHandler, selectView, reviewView, statusView, rpModal };
