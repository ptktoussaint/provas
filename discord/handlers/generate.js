const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  LabelBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const { build } = require('../customIds');
const { deferPrivate, deferUpdate, updatePrivate, operatorName, NO_PINGS } = require('../interactionUtils');
const { parseUserIdInput } = require('../../lib/discordIds');
const { truncate, safeName, LIMITS } = require('../format');
const svc = require('../generateService');

const COLOR = 0xdc2626;

function userIdModal() {
  return new ModalBuilder()
    .setCustomId(build('g', 'm'))
    .setTitle('Gerar Prova')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Usuário do Discord que fará a prova')
        .setDescription('Cole o ID (17 a 20 dígitos) ou a menção, ex.: <@123456789012345678>.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('uid').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(40)),
    );
}

function nameModal(req) {
  return new ModalBuilder()
    .setCustomId(build('g', 'nmm', req._id))
    .setTitle('Ajustar nome do aluno')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Nome que aparece na prova')
        .setDescription(truncate(`Aluno: ID ${req.targetUserId}`, LIMITS.labelDescription))
        .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(80).setValue(req.studentName)),
    );
}

function requestView(req, exams, notice = null) {
  const exam = exams.find((e) => String(e._id) === String(req.examId));
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Gerar Prova — confirme os dados')
    .addFields(
      { name: 'Aluno (Discord)', value: `<@${req.targetUserId}> (\`${req.targetUserId}\`)` },
      { name: 'Nome na prova', value: safeName(req.studentName, 80) || '—' },
      { name: 'Prova', value: exam ? safeName(exam.name, 100) : '⚠️ escolha a prova abaixo' },
      { name: 'Fiscal inicial', value: `<@${req.operatorId}> (você)` },
    )
    .setFooter({ text: 'A prova só começa quando o aluno abrir o link e iniciar.' });

  const rows = [];
  if (exams.length > 1) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(build('g', 'ex', req._id))
      .setPlaceholder('Escolha a prova')
      .addOptions(exams.slice(0, LIMITS.selectOptions).map((e) => ({
        label: truncate(e.name, LIMITS.selectLabel),
        description: truncate(`${e.questionCount} questões · ${e.durationMinutes} min`, LIMITS.selectDescription),
        value: String(e._id),
        default: String(e._id) === String(req.examId),
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(build('g', 'ok', req._id)).setLabel('Criar sala e gerar links').setStyle(ButtonStyle.Success).setDisabled(!exam),
    new ButtonBuilder().setCustomId(build('g', 'nm', req._id)).setLabel('Ajustar nome').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(build('g', 'x', req._id)).setLabel('Cancelar').setStyle(ButtonStyle.Danger),
  ));

  let content = notice || '';
  if (exams.length > LIMITS.selectOptions) content = `${content}\n⚠️ Há mais de ${LIMITS.selectOptions} provas ativas; só as ${LIMITS.selectOptions} mais recentes aparecem. Defina a prova padrão na aba Discord do site.`.trim();
  return { content, embeds: [embed], components: rows };
}

function openRoomView(room, notice) {
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('Já existe uma sala aberta para este aluno nesta prova')
    .setDescription([
      `Aluno: <@${room.discordUserId}> — ${safeName(room.studentName, 80)}`,
      `Sala: **${safeName(room.roomLabel, 60)}** (#${String(room._id).slice(-6)}) — situação: ${room.status === 'active' ? 'prova em andamento' : 'aguardando o aluno'}`,
      '',
      'Os links antigos não podem ser exibidos de novo (o site guarda só uma "impressão digital" deles, igual senha).',
      'Se precisar, gere **novos** links para esta mesma sala — os anteriores deixam de funcionar.',
    ].join('\n'));
  return {
    content: notice || '',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(build('g', 'rg', room._id)).setLabel('Gerar novos links para esta sala').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(build('g', 'rgx')).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function linksView({ title, room, exam, studentUrl, proctorUrl, targetUserId }) {
  const embed = new EmbedBuilder()
    .setColor(0x16a34a)
    .setTitle(title)
    .addFields(
      { name: 'Aluno', value: `<@${targetUserId}> — ${safeName(room.studentName, 80)}` },
      { name: 'Prova', value: exam ? safeName(exam.name, 100) : '—', inline: true },
      { name: 'Sala', value: `${safeName(room.roomLabel, 60)} (#${String(room._id).slice(-6)})`, inline: true },
      { name: '🔗 Link do ALUNO (envie só para o aluno)', value: studentUrl },
      { name: '👁️ Link do FISCAL (é seu — não envie ao aluno)', value: proctorUrl },
    )
    .setFooter({ text: 'Copie agora: os links não podem ser mostrados de novo. Se perder, use "Regenerar links" (os anteriores deixam de funcionar).' });
  const prefix = room.studentTokenHash ? room.studentTokenHash.slice(0, 12) : null;
  return {
    content: '',
    embeds: [embed],
    components: prefix ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(build('g', 'rg', room._id)).setLabel('Regenerar links').setStyle(ButtonStyle.Secondary),
    )] : [],
  };
}

function createGenerateHandler(ctx) {
  const scope = (interaction) => ({ guildId: ctx.guildId, operatorId: interaction.user.id });

  async function renderRequest(interaction, req, notice) {
    const exams = await svc.listActiveExams();
    return updatePrivate(interaction, requestView(req, exams, notice));
  }

  return async function handleGenerate(interaction, parts, config) {
    const [head, op, id, extra] = parts;

    // Botão do painel → formulário (precisa ser a primeira resposta).
    if (head === 'gen') return interaction.showModal(userIdModal());

    if (op === 'm') {
      await deferPrivate(interaction);
      const userId = parseUserIdInput(interaction.fields.getTextInputValue('uid'));
      if (!userId) return interaction.editReply({ content: '⚠️ ID inválido. Use o ID numérico do usuário (17 a 20 dígitos) ou a menção <@ID>.', allowedMentions: NO_PINGS });

      const member = await ctx.adapter.fetchMember(ctx.guildId, userId);
      if (!member) return interaction.editReply({ content: `⚠️ O usuário \`${userId}\` não foi encontrado neste servidor.`, allowedMentions: NO_PINGS });
      if (member.isBot) return interaction.editReply({ content: '⚠️ Esse usuário é um bot — não é possível gerar prova para ele.', allowedMentions: NO_PINGS });

      const exams = await svc.listActiveExams();
      const choice = svc.resolveExam(config.defaultExamId, exams);
      if (choice.error === 'no_active_exam') {
        return interaction.editReply({ content: '⚠️ Não há nenhuma prova apta no site (ativa e com questões ativas no banco). Ajuste na aba Provas & Questões antes de gerar. Nenhuma sala foi criada.', allowedMentions: NO_PINGS });
      }
      if (choice.examId) {
        const open = await svc.findOpenRoom({ guildId: ctx.guildId, userId, examId: choice.examId });
        if (open) return updatePrivate(interaction, openRoomView(open));
      }
      const req = await svc.createRequest({
        ...scope(interaction), operatorName: operatorName(interaction), targetUserId: userId, studentName: member.displayName, examId: choice.examId,
      });
      return updatePrivate(interaction, requestView(req, exams));
    }

    if (op === 'nm') {
      const req = await svc.loadRequest(id, scope(interaction));
      if (req.status !== 'pending') return updatePrivate(interaction, { content: 'Esta solicitação não está mais aberta.' });
      return interaction.showModal(nameModal(req));
    }

    if (op === 'nmm') {
      await deferUpdate(interaction);
      const req = await svc.loadRequest(id, scope(interaction));
      if (req.status !== 'pending') return updatePrivate(interaction, { content: 'Esta solicitação não está mais aberta.' });
      const name = svc.sanitizeStudentName(interaction.fields.getTextInputValue('name'));
      if (name.length < 2) return renderRequest(interaction, req, '⚠️ Nome muito curto.');
      req.studentName = name;
      await req.save();
      return renderRequest(interaction, req, '✅ Nome ajustado.');
    }

    if (op === 'ex') {
      await deferUpdate(interaction);
      const req = await svc.loadRequest(id, scope(interaction));
      if (req.status !== 'pending') return updatePrivate(interaction, { content: 'Esta solicitação não está mais aberta.' });
      const exams = await svc.listActiveExams();
      const chosen = exams.find((e) => String(e._id) === interaction.values[0]);
      if (!chosen) return renderRequest(interaction, req, '⚠️ Essa prova não está mais ativa.');
      const open = await svc.findOpenRoom({ guildId: ctx.guildId, userId: req.targetUserId, examId: chosen._id });
      if (open) {
        req.status = 'cancelled';
        await req.save();
        return updatePrivate(interaction, openRoomView(open));
      }
      req.examId = chosen._id;
      await req.save();
      return updatePrivate(interaction, requestView(req, exams));
    }

    if (op === 'x') {
      await deferUpdate(interaction);
      const req = await svc.loadRequest(id, scope(interaction));
      if (req.status === 'pending') { req.status = 'cancelled'; await req.save(); }
      return updatePrivate(interaction, { content: 'Cancelado — nenhuma sala foi criada.' });
    }

    if (op === 'ok') {
      await deferUpdate(interaction);
      const out = await svc.confirmRequest(id, { ...scope(interaction), publicBaseUrl: ctx.publicBaseUrl });
      if (out.kind === 'created') {
        return updatePrivate(interaction, linksView({ title: '✅ Sala criada', room: out.room, exam: out.exam, studentUrl: out.studentUrl, proctorUrl: out.proctorUrl, targetUserId: out.req.targetUserId }));
      }
      if (out.kind === 'already') {
        if (out.room) return updatePrivate(interaction, openRoomView({ ...out.room, discordUserId: out.req.targetUserId }, 'Esta solicitação já foi processada (clique repetido). Nenhuma sala nova foi criada.'));
        return updatePrivate(interaction, { content: 'Esta solicitação já está sendo processada. Aguarde alguns segundos e confira as salas.' });
      }
      if (out.kind === 'open_room') return updatePrivate(interaction, openRoomView(out.room));
      if (out.kind === 'expired') return updatePrivate(interaction, { content: 'Esta solicitação expirou (30 min). Clique em **Gerar Prova** no painel de novo.' });
      if (out.kind === 'cancelled') return updatePrivate(interaction, { content: 'Esta solicitação foi cancelada.' });
      if (out.kind === 'exam_inactive') return renderRequest(interaction, out.req, '⚠️ A prova escolhida não está mais apta (inativa ou sem questões ativas). Escolha outra.');
      return renderRequest(interaction, out.req, '⚠️ Escolha a prova antes de criar a sala.');
    }

    if (op === 'rg') {
      await deferUpdate(interaction);
      const Room = require('../../models/Room');
      const room = await Room.findOne({ _id: id, discordGuildId: ctx.guildId }).lean().catch(() => null);
      if (!room) return updatePrivate(interaction, { content: 'Sala não encontrada (ou não foi criada pelo Discord).' });
      if (room.status === 'closed') return updatePrivate(interaction, { content: 'Essa sala foi encerrada — gere uma prova nova.' });
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('Confirmar: gerar NOVOS links?')
        .setDescription([
          `Sala **${safeName(room.roomLabel, 60)}** (#${String(room._id).slice(-6)}) — aluno <@${room.discordUserId}>.`,
          '',
          '• O **link do aluno anterior deixa de funcionar** (quem já está na prova não é desconectado).',
          '• O **seu link de fiscal anterior** para esta sala também deixa de funcionar.',
          '• Os novos links aparecem só para você.',
        ].join('\n'));
      return updatePrivate(interaction, {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(build('g', 'rgok', room._id, room.studentTokenHash.slice(0, 12))).setLabel('Sim, gerar novos links').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(build('g', 'rgx')).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    if (op === 'rgok') {
      await deferUpdate(interaction);
      const out = await svc.regenerateLinks(id, {
        guildId: ctx.guildId, operatorId: interaction.user.id, operatorName: operatorName(interaction), expectedPrefix: extra, publicBaseUrl: ctx.publicBaseUrl,
      });
      if (out.kind === 'ok') {
        const Exam = require('../../models/Exam');
        const exam = await Exam.findById(out.room.examId).select('name').lean();
        return updatePrivate(interaction, linksView({ title: '🔁 Novos links gerados (os anteriores foram invalidados)', room: out.room, exam, studentUrl: out.studentUrl, proctorUrl: out.proctorUrl, targetUserId: out.room.discordUserId }));
      }
      if (out.kind === 'stale') return updatePrivate(interaction, { content: 'Os links desta sala já foram trocados depois que esta confirmação apareceu (clique repetido?). Nada foi alterado agora. Se precisar, clique em "Regenerar links" de novo.' });
      if (out.kind === 'closed') return updatePrivate(interaction, { content: 'Essa sala foi encerrada — gere uma prova nova.' });
      return updatePrivate(interaction, { content: 'Sala não encontrada.' });
    }

    if (op === 'rgx') {
      await deferUpdate(interaction);
      return updatePrivate(interaction, { content: 'Cancelado — nenhum link foi alterado.' });
    }

    return undefined;
  };
}

module.exports = { createGenerateHandler, requestView, openRoomView, linksView };
