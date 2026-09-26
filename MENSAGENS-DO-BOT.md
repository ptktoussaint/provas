# Mensagens do Bot — editor de mensagens e embeds

Aba **Mensagens do Bot** do painel admin. Aqui você muda o texto e o visual de tudo o que o bot mostra a partir do site, sem mexer no BotGhost.

## Como funciona

- Cada situação tem um **modelo**: painel, sala criada, resultado, consulta, promoção, anúncio, acesso negado, etc. A tabela no fim desta página lista todos.
- O modelo pode ter **texto fora do embed** e **um embed** com: título, link do título, cor (seletor ou `#RRGGBB`), autor (nome, link, ícone), miniatura, imagem, rodapé (texto e ícone), data/hora e até 25 **campos**. Os campos podem ser adicionados, removidos, reordenados (▲▼) e ficar "lado a lado".
- **Salvar rascunho** guarda sem valer ainda.
- **Publicar** passa a valer para as **próximas** mensagens. Mensagens antigas no Discord **não** mudam.
- **Restaurar padrão** volta ao modelo TCEL original e fica registrado no histórico.
- **Versões publicadas**: cada publicação fica guardada no banco com autor e data (as últimas 20).
- **Enviar teste**: publica a versão **publicada** no **canal de teste** configurado na aba Integração, com dados **fictícios** e **sem notificar ninguém**. Só funciona com os avisos por webhook ligados (Parte E do BOTGHOST-MONTAGEM.md).

## Variáveis `[[...]]`

- Escreva `[[nome.da.variavel]]` ou use **Inserir variável** (entra onde está o cursor).
- Cada modelo só aceita as variáveis dele. Uma variável desconhecida ou de outro modelo **impede a publicação** e aparece com erro no próprio campo.
- A troca é feita **uma única vez**. Se um nome de aluno contiver `[[algo]]`, isso aparece como texto: não vira outra variável.
- Os **links de prova** (`[[links.aluno]]`, `[[links.fiscal]]`) só são aceitos no modelo privado **Sala criada**. Nesse modelo, `[[fiscal.mencao]]` / `[[fiscal.nome]]` mostram o fiscal escolhido no formulário (dono do link de fiscal). Se você já tinha publicado uma versão própria de "Sala criada", use **Restaurar padrão** para ganhar o campo **Fiscal**. Nunca aparecem na prévia, no teste nem no histórico: ali eles são fictícios.
- Campos de **link e imagem** não aceitam variáveis.

## Menções × notificações (ping)

- **Menção** é o texto `<@ID>` (usuário), `<@&ID>` (cargo) ou `<#ID>` (canal). Mostra o nome, mas **sozinha não notifica**. Use **Inserir menção**.
- **Ping** (notificação) só acontece para quem estiver marcado em "Quem é notificado" **e** aparecer no **texto fora do embed**.
- `@everyone` e `@here` **nunca** são liberados.
- **Edições e testes nunca notificam.** Mensagens privadas também não.
- O anúncio de promoção notifica, por padrão, os promovidos e o cargo do anúncio. Em lotes grandes, o cargo só é notificado na primeira mensagem.

## Imagens

- Use o **link direto do arquivo** (`https://…/imagem.png`, `.jpg`, `.gif`, `.webp`). Links de páginas (Google Drive, etc.) não funcionam.
- O editor mostra na hora "✓ imagem carregou" ou "✗ não carregou". Quem baixa a imagem para conferir é o **seu navegador**; o site nunca baixa o link.
- Não é aceito: `http://`, endereço IP, `localhost` ou link com usuário/senha.

## Limites do Discord (conferidos ao publicar e em cada mensagem real)

- Texto: 2000 caracteres. Título: 256. Descrição: 4096. Campos: 25, com nome até 256 e valor até 1024. Rodapé: 2048. Autor: 256. Embed inteiro: 6000.
- Os contadores ao lado de cada campo mostram o tamanho do modelo. O limite vale **depois** de trocar as variáveis. Listas longas (resultados) são **divididas em páginas**, nunca cortadas.

## Como o BotGhost usa (ligação dos campos)

Cada resposta do site traz a mensagem pronta de três formas (detalhes em BOTGHOST-API.md §2):
- `data.native.*` — campos soltos para ligar no bloco **Send or Edit a Message**: Content, Title, Description (use `descriptionWithFields`, que já inclui os campos), Color, Footer, Author, Thumbnail, Image, Timestamp e os IDs para **Allowed Mentions**. O bloco nativo tem um número fixo de campos; por isso os campos do modelo vêm juntos na descrição.
- `data.discordBodyJson` — o corpo pronto para a API do Discord (modo recomendado para mensagens em canal). Embed completo, com campos separados e `allowed_mentions` exato.
- `data.message` — o mesmo em formato de objeto (para conferência).

Nunca aparece `[object Object]` nem JSON como texto na mensagem. O Discord não permite misturar **Components V2** com embeds; não use Components V2 nesses blocos.

## Testes feitos

- **Automatizados** (`npm test` / `npm run test:integration`):
  - todos os modelos padrão validam e cabem nos limites;
  - variável desconhecida é recusada;
  - link fora do modelo privado é recusado;
  - chaves, aspas, HTML e barras não quebram o JSON;
  - URL de imagem com IP/localhost/http é recusada;
  - edição/teste nunca pinga;
  - anúncio com uma menção por linha.
- **No navegador real** (Playwright):
  - HTML digitado aparece como texto na prévia, sem executar;
  - reordenar campos e inserir variável funcionam;
  - publicar vale para a próxima edição da mensagem.
- **Pendente:** ver o embed num Discord real. Faça pelo **Enviar teste** depois de montar a Parte E do BOTGHOST-MONTAGEM.md.

## Prova oral

Na aba **Resultados**, o botão **Adicionar Pontos Prova Oral** soma pontos à nota da prova. Não há limite de 100: a soma pode passar. Com prova oral lançada, o bot usa o modelo **Resultado com Prova Oral**, cujo padrão é:

> Prova finalizada: @aluno — Prova (80) + Prova Oral (15) = 95 — Prova: NOME

Se a mensagem já tinha sido publicada, ela é **editada**, sem novo ping. Variáveis desse modelo:
- `[[resultado.notaProva]]` — nota da prova escrita
- `[[resultado.notaOral]]` — pontos da prova oral
- `[[resultado.notaFinal]]` — a soma das duas

## Referência: variáveis e modelos

| Variável | O que é | Exemplo fictício |
|---|---|---|
| `[[data]]` | Data e hora atuais (horário de Brasília) | 24/09/2026 14:30 |
| `[[operador.mencao]]` | Menção do operador que clicou | <@100000000000000001> |
| `[[operador.nome]]` | Nome exibido do operador | Sargento Exemplo |
| `[[operador.discordId]]` | ID do Discord do operador | 100000000000000001 |
| `[[aluno.mencao]]` | Menção do aluno (ID cadastrado) | <@200000000000000002> |
| `[[aluno.nome]]` | Nome do aluno na prova | Recruta Fictício |
| `[[aluno.discordId]]` | ID do Discord do aluno | 200000000000000002 |
| `[[fiscal.mencao]]` | Menção do fiscal dono do link (o escolhido no formulário) | <@400000000000000004> |
| `[[fiscal.nome]]` | Nome do fiscal dono do link | Cabo Fiscal Exemplo |
| `[[fiscal.discordId]]` | ID do Discord do fiscal | 400000000000000004 |
| `[[prova.nome]]` | Nome da prova | Prova TCEL (exemplo) |
| `[[prova.duracao]]` | Duração da prova | 120 minutos |
| `[[sala.nome]]` | Nome da sala | Discord ABC12 |
| `[[sala.codigo]]` | Código curto da sala | #a1b2c3 |
| `[[links.aluno]]` | Link do ALUNO (só em mensagem privada) ⚠️ | (link fictício) |
| `[[links.fiscal]]` | Link do FISCAL (só em mensagem privada) ⚠️ | (link fictício) |
| `[[resultado.nota]]` | Nota final (prova + prova oral, se houver) | 86 |
| `[[resultado.notaProva]]` | Nota da prova escrita | 80 |
| `[[resultado.notaOral]]` | Pontos da prova oral | 6 |
| `[[resultado.notaFinal]]` | Prova + Prova Oral | 86 |
| `[[resultado.total]]` | Pontuação máxima da tentativa | 100 |
| `[[resultado.notaOriginal]]` | Nota calculada pelo site | 80 |
| `[[resultado.situacao]]` | Finalizada / tempo esgotado | finalizada |
| `[[resultado.tentativa]]` | Código curto da tentativa | a1b2c3 |
| `[[resultado.data]]` | Data de término | 24/09/2026 14:10 |
| `[[avaliador.mencao]]` | Menção do avaliador (fiscal escolhido no /provas-dafp) | <@400000000000000004> |
| `[[avaliador.nome]]` | Nome do avaliador | Capitão Avaliador |
| `[[avaliador.discordId]]` | ID do Discord do avaliador | 400000000000000004 |
| `[[resultado.status]]` | APROVADO / REPROVADO (ou "Nota registrada" sem aprovação automática) | APROVADO |
| `[[resultado.notaMinima]]` | Nota mínima para aprovação (vazio sem aprovação automática) | 7 |
| `[[resultado.cargoMencao]]` | Menção do cargo do resultado (aprovado ou reprovado) | <@&300000000000000007> |
| `[[lista.resultados]]` | Lista da página de resultados | **1.** <@200000000000000002> · Recruta Fictício — **86/100** · Prova TCEL (exemplo) · 24/09/2026 · tentativa `a1b2c3` · não promovido |
| `[[pagina.atual]]` | Página atual | 1 |
| `[[pagina.total]]` | Total de páginas | 3 |
| `[[resultados.total]]` | Quantidade de resultados | 24 |
| `[[filtro.descricao]]` | Filtros aplicados | Todos os resultados não excluídos. |
| `[[selecao.lista]]` | Pessoas no lote de promoção | • <@200000000000000002> — Recruta Fictício — 86/100 — RP: 『TCEL•B』Fictício \| 007 |
| `[[selecao.total]]` | Quantidade no lote | 1 |
| `[[candidatos.lista]]` | Candidatos da página | `1` Recruta Fictício — 86/100 — Prova TCEL (exemplo) |
| `[[proximo.mencao]]` | Próxima pessoa a preencher | <@200000000000000002> |
| `[[proximo.nome]]` | Nome da próxima pessoa a preencher | Recruta Fictício |
| `[[revisao.lista]]` | Revisão por pessoa | • <@200000000000000002> → `『TCEL•B』Fictício \| 007` · nota 86/100 |
| `[[revisao.total]]` | Quantidade revisada | 1 |
| `[[revisao.bloqueios]]` | Bloqueios encontrados na revisão | Nenhum bloqueio. |
| `[[promocao.cargoMencao]]` | Menção do cargo do anúncio | <@&300000000000000003> |
| `[[promocao.cargosAdicionar]]` | Cargos adicionados | +<@&300000000000000003> +<@&300000000000000004> |
| `[[promocao.cargosRemover]]` | Cargos removidos | −<@&300000000000000005> |
| `[[promocao.listaMencoes]]` | Promovidos, uma menção por linha | <@200000000000000002> <@200000000000000006> |
| `[[promocao.listaApelidos]]` | Promovidos com o apelido novo | <@200000000000000002> → 『TCEL•B』Fictício \| 007 |
| `[[promocao.listaFalhas]]` | Pessoas com falha e o motivo | <@200000000000000006> — sem permissão para alterar apelido |
| `[[promocao.total]]` | Quantidade promovida | 2 |
| `[[acesso.motivo]]` | Motivo da negação | Você não está autorizado a gerar provas. |

| Modelo (chave) | Quem vê | Variáveis aceitas | Pode notificar |
|---|---|---|---|
| Painel /provatcel (`panel`) | canal | `[[data]]` | ninguém |
| Sala criada (links) (`room_created`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[aluno.mencao]]` `[[aluno.nome]]` `[[aluno.discordId]]` `[[prova.nome]]` `[[fiscal.mencao]]` `[[fiscal.nome]]` `[[fiscal.discordId]]` `[[prova.duracao]]` `[[sala.nome]]` `[[sala.codigo]]` `[[links.aluno]]` `[[links.fiscal]]` | ninguém |
| Resultado concluído (canal) (`result_finished`) | canal | `[[data]]` `[[aluno.mencao]]` `[[aluno.nome]]` `[[aluno.discordId]]` `[[prova.nome]]` `[[resultado.nota]]` `[[resultado.total]]` `[[resultado.situacao]]` `[[resultado.tentativa]]` `[[resultado.data]]` | Aluno (menção [[aluno.mencao]]) |
| Resultado com Prova Oral (`result_updated`) | canal | `[[data]]` `[[aluno.mencao]]` `[[aluno.nome]]` `[[aluno.discordId]]` `[[prova.nome]]` `[[resultado.nota]]` `[[resultado.total]]` `[[resultado.situacao]]` `[[resultado.tentativa]]` `[[resultado.data]]` `[[resultado.notaOriginal]]` `[[resultado.notaProva]]` `[[resultado.notaOral]]` `[[resultado.notaFinal]]` | ninguém |
| Resultado DAFP (canal) (`dafp_result`) | canal | `[[data]]` `[[aluno.mencao]]` `[[aluno.nome]]` `[[aluno.discordId]]` `[[prova.nome]]` `[[avaliador.mencao]]` `[[avaliador.nome]]` `[[avaliador.discordId]]` `[[resultado.nota]]` `[[resultado.total]]` `[[resultado.situacao]]` `[[resultado.tentativa]]` `[[resultado.data]]` `[[resultado.status]]` `[[resultado.notaMinima]]` `[[resultado.cargoMencao]]` | Aluno, Avaliador |
| Resultado removido (edição da mensagem) (`result_removed`) | canal | `[[data]]` `[[aluno.mencao]]` `[[aluno.nome]]` `[[aluno.discordId]]` `[[prova.nome]]` `[[resultado.tentativa]]` | ninguém |
| Consulta de resultados (`results_list`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[lista.resultados]]` `[[pagina.atual]]` `[[pagina.total]]` `[[resultados.total]]` `[[filtro.descricao]]` | ninguém |
| Consulta sem resultados (`results_empty`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[filtro.descricao]]` | ninguém |
| Promoção — seleção (`promotion_selection`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[selecao.lista]]` `[[selecao.total]]` `[[candidatos.lista]]` `[[pagina.atual]]` `[[pagina.total]]` `[[proximo.mencao]]` `[[proximo.nome]]` | ninguém |
| Promoção — revisão final (`promotion_review`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[revisao.lista]]` `[[revisao.total]]` `[[revisao.bloqueios]]` `[[promocao.cargoMencao]]` `[[promocao.cargosAdicionar]]` `[[promocao.cargosRemover]]` | ninguém |
| Promoção concluída (resposta ao operador) (`promotion_completed`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[promocao.listaMencoes]]` `[[promocao.listaApelidos]]` `[[promocao.total]]` `[[promocao.cargoMencao]]` | ninguém |
| Anúncio de promovidos (canal) (`promotion_announcement`) | canal | `[[data]]` `[[promocao.cargoMencao]]` `[[promocao.listaMencoes]]` `[[promocao.listaApelidos]]` `[[promocao.total]]` | Promovidos (menções da lista), Cargo do anúncio ([[promocao.cargoMencao]]) |
| Promoção com falha parcial (`promotion_partial`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[promocao.listaMencoes]]` `[[promocao.listaFalhas]]` `[[promocao.total]]` | ninguém |
| Acesso negado (`access_denied`) | só o operador | `[[data]]` `[[operador.mencao]]` `[[operador.nome]]` `[[operador.discordId]]` `[[acesso.motivo]]` | ninguém |
| Indisponível (`unavailable`) | só o operador | `[[data]]` | ninguém |
