// Catálogo dos modelos de mensagem da integração TCEL: quais existem, quem
// vê (privado = só o operador; público = canal), quais variáveis [[...]]
// cada um aceita, quem pode ser notificado (ping) e o texto padrão.
// Os exemplos (sample) são FICTÍCIOS — usados só na prévia e no teste.

const PLACEHOLDERS = {
  data: { help: 'Data e hora atuais (horário de Brasília)', sample: '24/09/2026 14:30' },
  'operador.mencao': { help: 'Menção do operador que clicou', sample: '<@100000000000000001>' },
  'operador.nome': { help: 'Nome exibido do operador', sample: 'Sargento Exemplo' },
  'operador.discordId': { help: 'ID do Discord do operador', sample: '100000000000000001' },
  'aluno.mencao': { help: 'Menção do aluno (ID cadastrado)', sample: '<@200000000000000002>' },
  'aluno.nome': { help: 'Nome do aluno na prova', sample: 'Recruta Fictício' },
  'aluno.discordId': { help: 'ID do Discord do aluno', sample: '200000000000000002' },
  'fiscal.mencao': { help: 'Menção do fiscal dono do link (o escolhido no formulário)', sample: '<@400000000000000004>' },
  'fiscal.nome': { help: 'Nome do fiscal dono do link', sample: 'Cabo Fiscal Exemplo' },
  'fiscal.discordId': { help: 'ID do Discord do fiscal', sample: '400000000000000004' },
  'prova.nome': { help: 'Nome da prova', sample: 'Prova TCEL (exemplo)' },
  'prova.duracao': { help: 'Duração da prova', sample: '120 minutos' },
  'sala.nome': { help: 'Nome da sala', sample: 'Discord ABC12' },
  'sala.codigo': { help: 'Código curto da sala', sample: '#a1b2c3' },
  'links.aluno': { help: 'Link do ALUNO (só em mensagem privada)', sample: 'https://exemplo.invalid/aluno/LINK-FICTICIO', sensitive: true },
  'links.fiscal': { help: 'Link do FISCAL (só em mensagem privada)', sample: 'https://exemplo.invalid/professor/LINK-FICTICIO', sensitive: true },
  'resultado.nota': { help: 'Nota final (prova + prova oral, se houver)', sample: '86' },
  'resultado.notaProva': { help: 'Nota da prova escrita', sample: '80' },
  'resultado.notaOral': { help: 'Pontos da prova oral', sample: '6' },
  'resultado.notaFinal': { help: 'Prova + Prova Oral', sample: '86' },
  'resultado.total': { help: 'Pontuação máxima da tentativa', sample: '100' },
  'resultado.notaOriginal': { help: 'Nota calculada pelo site', sample: '80' },
  'resultado.situacao': { help: 'Finalizada / tempo esgotado', sample: 'finalizada' },
  'resultado.tentativa': { help: 'Código curto da tentativa', sample: 'a1b2c3' },
  'resultado.data': { help: 'Data de término', sample: '24/09/2026 14:10' },
  'avaliador.mencao': { help: 'Menção do avaliador (fiscal escolhido no /provas-dafp)', sample: '<@400000000000000004>' },
  'avaliador.nome': { help: 'Nome do avaliador', sample: 'Capitão Avaliador' },
  'avaliador.discordId': { help: 'ID do Discord do avaliador', sample: '400000000000000004' },
  'resultado.status': { help: 'APROVADO / REPROVADO (ou "Nota registrada" sem aprovação automática)', sample: 'APROVADO' },
  'resultado.notaMinima': { help: 'Nota mínima para aprovação (vazio sem aprovação automática)', sample: '7' },
  'resultado.cargoMencao': { help: 'Menção do cargo de aprovado da prova (vazio se não aprovado)', sample: '<@&300000000000000007>' },
  'resultado.gabaritou': { help: 'Sim / Não — tirou a nota máxima (decidido pelo site)', sample: 'Não' },
  'lista.resultados': { help: 'Lista da página de resultados', sample: '**1.** <@200000000000000002> · Recruta Fictício — **86/100** · Prova TCEL (exemplo) · 24/09/2026 · tentativa `a1b2c3` · não promovido' },
  'pagina.atual': { help: 'Página atual', sample: '1' },
  'pagina.total': { help: 'Total de páginas', sample: '3' },
  'resultados.total': { help: 'Quantidade de resultados', sample: '24' },
  'filtro.descricao': { help: 'Filtros aplicados', sample: 'Todos os resultados não excluídos.' },
  'selecao.lista': { help: 'Pessoas no lote de promoção', sample: '• <@200000000000000002> — Recruta Fictício — 86/100 — RP: 『TCEL•B』Fictício | 007' },
  'selecao.total': { help: 'Quantidade no lote', sample: '1' },
  'candidatos.lista': { help: 'Candidatos da página', sample: '`1` Recruta Fictício — 86/100 — Prova TCEL (exemplo)' },
  'proximo.mencao': { help: 'Próxima pessoa a preencher', sample: '<@200000000000000002>' },
  'proximo.nome': { help: 'Nome da próxima pessoa a preencher', sample: 'Recruta Fictício' },
  'revisao.lista': { help: 'Revisão por pessoa', sample: '• <@200000000000000002> → `『TCEL•B』Fictício | 007` · nota 86/100' },
  'revisao.total': { help: 'Quantidade revisada', sample: '1' },
  'revisao.bloqueios': { help: 'Bloqueios encontrados na revisão', sample: 'Nenhum bloqueio.' },
  'promocao.cargoMencao': { help: 'Menção do cargo do anúncio', sample: '<@&300000000000000003>' },
  'promocao.cargosAdicionar': { help: 'Cargos adicionados', sample: '+<@&300000000000000003> +<@&300000000000000004>' },
  'promocao.cargosRemover': { help: 'Cargos removidos', sample: '−<@&300000000000000005>' },
  'promocao.listaMencoes': { help: 'Promovidos, uma menção por linha', sample: '<@200000000000000002>\n<@200000000000000006>' },
  'promocao.listaApelidos': { help: 'Promovidos com o apelido novo', sample: '<@200000000000000002> → 『TCEL•B』Fictício | 007' },
  'promocao.listaFalhas': { help: 'Pessoas com falha e o motivo', sample: '<@200000000000000006> — sem permissão para alterar apelido' },
  'promocao.total': { help: 'Quantidade promovida', sample: '2' },
  'acesso.motivo': { help: 'Motivo da negação', sample: 'Você não está autorizado a gerar provas.' },
};

const BASE = ['data', 'operador.mencao', 'operador.nome', 'operador.discordId'];
const STUDENT = ['aluno.mencao', 'aluno.nome', 'aluno.discordId', 'prova.nome'];
const RESULT = ['resultado.nota', 'resultado.total', 'resultado.situacao', 'resultado.tentativa', 'resultado.data'];

const RED = '#dc2626';

function embed(e) {
  return {
    enabled: true,
    title: '', description: '', url: '', color: RED,
    authorName: '', authorUrl: '', authorIconUrl: '',
    thumbnailUrl: '', imageUrl: '',
    footerText: '', footerIconUrl: '',
    timestamp: false,
    fields: [],
    ...e,
  };
}

const NO_EMBED = { ...embed({}), enabled: false };
const NO_PINGS = { users: [], roles: [], extraUserIds: [], extraRoleIds: [] };

const TEMPLATES = {
  panel: {
    label: 'Painel /provatcel',
    visibility: 'public',
    help: 'Mensagem do painel com os botões. Os BOTÕES são do BotGhost; aqui muda só o texto/visual. Use "Atualizar painel" para aplicar na mensagem existente.',
    placeholders: ['data'],
    pingTargets: [],
    default: {
      content: '',
      embed: embed({
        title: '🔥 Prova TCEL — Painel da equipe',
        description: '**Gerar Prova** — cria a sala da prova para um membro e entrega só para você o link do aluno e o link do fiscal escolhido.\n**Conferir resultados** — histórico de notas direto do site.\n**Promover** — promoção em lote, com revisão antes de aplicar.\n\nAs respostas são privadas: só quem clicou vê.',
        footerText: 'PROVA TCEL BOMBEIROS SUL',
      }),
      pings: NO_PINGS,
    },
  },
  room_created: {
    label: 'Sala criada (links)',
    visibility: 'private',
    allowsLinks: true,
    help: 'Resposta PRIVADA ao operador com os links. Único modelo que pode ter [[links.aluno]] e [[links.fiscal]].',
    placeholders: [...BASE, ...STUDENT, 'fiscal.mencao', 'fiscal.nome', 'fiscal.discordId', 'prova.duracao', 'sala.nome', 'sala.codigo', 'links.aluno', 'links.fiscal'],
    pingTargets: [],
    default: {
      content: '',
      embed: embed({
        title: '✅ Sala criada',
        color: '#16a34a',
        fields: [
          { name: 'Aluno', value: '[[aluno.mencao]] — [[aluno.nome]]', inline: false },
          { name: 'Fiscal', value: '[[fiscal.mencao]] — [[fiscal.nome]]', inline: false },
          { name: 'Prova', value: '[[prova.nome]]', inline: true },
          { name: 'Sala', value: '[[sala.nome]] ([[sala.codigo]])', inline: true },
          { name: '🔗 Link do ALUNO (envie só para o aluno)', value: '[[links.aluno]]', inline: false },
          { name: '👁️ Link do FISCAL (envie só para o fiscal acima, em privado — nunca ao aluno)', value: '[[links.fiscal]]', inline: false },
        ],
        footerText: 'Copie agora: os links não podem ser mostrados de novo. Se perder, use Regenerar links. Não cole em canal público.',
      }),
      pings: NO_PINGS,
    },
  },
  result_finished: {
    label: 'Resultado concluído (canal)',
    visibility: 'public',
    help: 'Aviso no canal de resultados quando a prova termina.',
    placeholders: ['data', ...STUDENT, ...RESULT],
    pingTargets: ['aluno'],
    default: {
      content: 'Prova finalizada: [[aluno.mencao]] — Nota: [[resultado.nota]] / [[resultado.total]] — Prova: [[prova.nome]]',
      embed: NO_EMBED,
      pings: NO_PINGS,
    },
  },
  result_updated: {
    label: 'Resultado com Prova Oral',
    visibility: 'public',
    help: 'Usado quando o admin lança pontos da prova oral: edita a mensagem já publicada (ou é a primeira, se ainda não saiu). Edições nunca notificam ninguém.',
    placeholders: ['data', ...STUDENT, ...RESULT, 'resultado.notaOriginal', 'resultado.notaProva', 'resultado.notaOral', 'resultado.notaFinal'],
    pingTargets: [],
    default: {
      content: 'Prova finalizada: [[aluno.mencao]] — Prova ([[resultado.notaProva]]) + Prova Oral ([[resultado.notaOral]]) = [[resultado.notaFinal]] — Prova: [[prova.nome]]',
      embed: NO_EMBED,
      pings: NO_PINGS,
    },
  },
  dafp_result: {
    label: 'Resultado DAFP (canal)',
    visibility: 'public',
    help: 'Resultado de uma prova DAFP (/provas-dafp) no canal de resultados DAFP. Os cargos (Role base, aprovado e Mérito) são aplicados pelo BotGhost no mesmo evento (campos roleAction1..3 da reserva).',
    placeholders: ['data', ...STUDENT, 'avaliador.mencao', 'avaliador.nome', 'avaliador.discordId', ...RESULT, 'resultado.status', 'resultado.notaMinima', 'resultado.cargoMencao', 'resultado.gabaritou'],
    pingTargets: ['aluno', 'avaliador'],
    default: {
      content: '',
      embed: embed({
        title: 'RESULTADO DA PROVA',
        fields: [
          { name: 'Aluno', value: '[[aluno.mencao]]', inline: true },
          { name: 'Avaliador', value: '[[avaliador.mencao]]', inline: true },
          { name: 'Prova', value: '[[prova.nome]]', inline: false },
          { name: 'Nota', value: '[[resultado.nota]]/[[resultado.total]]', inline: true },
          { name: 'Resultado', value: '[[resultado.status]]', inline: true },
        ],
        footerText: 'Finalizada em [[resultado.data]]',
      }),
      pings: NO_PINGS,
    },
  },
  result_removed: {
    label: 'Resultado removido (edição da mensagem)',
    visibility: 'public',
    help: 'Usado para EDITAR a mensagem original quando o admin exclui o resultado.',
    placeholders: ['data', ...STUDENT, 'resultado.tentativa'],
    pingTargets: [],
    default: {
      content: '~~Prova finalizada: [[aluno.mencao]] — Prova: [[prova.nome]]~~\nResultado removido pelo admin.',
      embed: NO_EMBED,
      pings: NO_PINGS,
    },
  },
  results_list: {
    label: 'Consulta de resultados',
    visibility: 'private',
    help: 'Resposta privada do botão Conferir resultados (uma página).',
    placeholders: [...BASE, 'lista.resultados', 'pagina.atual', 'pagina.total', 'resultados.total', 'filtro.descricao'],
    pingTargets: [],
    list: 'lista.resultados',
    default: {
      content: '',
      embed: embed({
        title: '📊 Resultados ([[resultados.total]])',
        color: '#2563eb',
        description: '[[filtro.descricao]]\n\n[[lista.resultados]]',
        footerText: 'Página [[pagina.atual]]/[[pagina.total]] · Fotografia de agora — use Atualizar para ver mudanças.',
        timestamp: true,
      }),
      pings: NO_PINGS,
    },
  },
  results_empty: {
    label: 'Consulta sem resultados',
    visibility: 'private',
    help: 'Quando a consulta não encontra nada.',
    placeholders: [...BASE, 'filtro.descricao'],
    pingTargets: [],
    default: {
      content: '',
      embed: embed({ title: '📊 Resultados', color: '#2563eb', description: 'Nenhum resultado encontrado.\n[[filtro.descricao]]' }),
      pings: NO_PINGS,
    },
  },
  promotion_selection: {
    label: 'Promoção — seleção',
    visibility: 'private',
    help: 'Tela privada de seleção do lote e preenchimento dos dados RP.',
    placeholders: [...BASE, 'selecao.lista', 'selecao.total', 'candidatos.lista', 'pagina.atual', 'pagina.total', 'proximo.mencao', 'proximo.nome'],
    pingTargets: [],
    list: 'candidatos.lista',
    default: {
      content: '',
      embed: embed({
        title: '🎖️ Promover — seleção',
        color: '#16a34a',
        description: '**Selecionados ([[selecao.total]]):**\n[[selecao.lista]]\n\n**Candidatos (página [[pagina.atual]]/[[pagina.total]]):**\n[[candidatos.lista]]',
        footerText: 'Próximo a preencher: [[proximo.nome]]',
      }),
      pings: NO_PINGS,
    },
  },
  promotion_review: {
    label: 'Promoção — revisão final',
    visibility: 'private',
    help: 'Revisão antes de confirmar. Nada muda no Discord antes da confirmação.',
    placeholders: [...BASE, 'revisao.lista', 'revisao.total', 'revisao.bloqueios', 'promocao.cargoMencao', 'promocao.cargosAdicionar', 'promocao.cargosRemover'],
    pingTargets: [],
    list: 'revisao.lista',
    default: {
      content: '',
      embed: embed({
        title: '🔎 Revisão final — confira antes de confirmar',
        color: '#16a34a',
        description: '[[revisao.bloqueios]]\nPara cada pessoa: [[promocao.cargosAdicionar]] [[promocao.cargosRemover]] e apelido novo.\n\n[[revisao.lista]]',
        footerText: 'Cancelar ou sair daqui não altera ninguém.',
      }),
      pings: NO_PINGS,
    },
  },
  promotion_completed: {
    label: 'Promoção concluída (resposta ao operador)',
    visibility: 'private',
    help: 'Relatório privado ao final do lote, quando tudo deu certo.',
    placeholders: [...BASE, 'promocao.listaMencoes', 'promocao.listaApelidos', 'promocao.total', 'promocao.cargoMencao'],
    pingTargets: [],
    list: 'promocao.listaApelidos',
    default: {
      content: '',
      embed: embed({ title: '✅ Promoção concluída ([[promocao.total]])', color: '#16a34a', description: '[[promocao.listaApelidos]]' }),
      pings: NO_PINGS,
    },
  },
  promotion_announcement: {
    label: 'Anúncio de promovidos (canal)',
    visibility: 'public',
    help: 'Anúncio no canal de promoções, só com quem foi concluído. Lotes grandes viram várias mensagens.',
    placeholders: ['data', 'promocao.cargoMencao', 'promocao.listaMencoes', 'promocao.listaApelidos', 'promocao.total'],
    pingTargets: ['promovidos', 'cargoPromocao'],
    list: 'promocao.listaMencoes',
    default: {
      content: 'Parabéns aos promovidos para [[promocao.cargoMencao]]\n[[promocao.listaMencoes]]',
      embed: NO_EMBED,
      pings: { users: ['promovidos'], roles: ['cargoPromocao'], extraUserIds: [], extraRoleIds: [] },
    },
  },
  promotion_partial: {
    label: 'Promoção com falha parcial',
    visibility: 'private',
    help: 'Relatório privado quando alguma pessoa não foi concluída.',
    placeholders: [...BASE, 'promocao.listaMencoes', 'promocao.listaFalhas', 'promocao.total'],
    pingTargets: [],
    list: 'promocao.listaFalhas',
    default: {
      content: '',
      embed: embed({
        title: '⚠️ Promoção com pendências',
        color: '#f59e0b',
        description: '**Concluídos:**\n[[promocao.listaMencoes]]\n\n**Com falha / em revisão:**\n[[promocao.listaFalhas]]',
        footerText: 'Use Retomar para refazer só o que ficou pendente.',
      }),
      pings: NO_PINGS,
    },
  },
  access_denied: {
    label: 'Acesso negado',
    visibility: 'private',
    help: 'Quando o site recusa o operador. O BotGhost também precisa de uma versão LOCAL para quando o site nem responde.',
    placeholders: [...BASE, 'acesso.motivo'],
    pingTargets: [],
    default: { content: '⛔ [[acesso.motivo]]', embed: NO_EMBED, pings: NO_PINGS },
  },
  unavailable: {
    label: 'Indisponível',
    visibility: 'private',
    help: 'Usado quando o site responde mas não pode atender (ex.: integração desligada). Se o site nem responder, vale a mensagem LOCAL do BotGhost.',
    placeholders: ['data'],
    pingTargets: [],
    default: { content: '⏳ O site da prova está iniciando ou indisponível. Abra o site, aguarde carregar e tente novamente.', embed: NO_EMBED, pings: NO_PINGS },
  },
};

// Quem pode ser notificado, por alvo de ping (IDs vêm do contexto real).
const PING_TARGET_LABELS = {
  aluno: 'Aluno (menção [[aluno.mencao]])',
  avaliador: 'Avaliador DAFP (menção [[avaliador.mencao]])',
  operador: 'Operador',
  promovidos: 'Promovidos (menções da lista)',
  cargoPromocao: 'Cargo do anúncio ([[promocao.cargoMencao]])',
};

function sampleContext(key) {
  const t = TEMPLATES[key];
  const ctx = {};
  for (const p of t.placeholders) ctx[p] = PLACEHOLDERS[p].sample;
  return ctx;
}

module.exports = { TEMPLATES, PLACEHOLDERS, PING_TARGET_LABELS, sampleContext, embed, NO_PINGS };
