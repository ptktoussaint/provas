# Montagem no BotGhost — só os fluxos NOVOS da Prova TCEL

Manual bloco a bloco para montar, **à mão**, no painel do BotGhost:
- o comando `/provatcel` e seus 3 botões;
- o evento que publica os avisos.

Não existe importação automática de blocos: o BotGhost não tem um formato oficial de importação que tenha sido testado aqui, então tudo é montado manualmente.

Referência de cada pedido: **BOTGHOST-API.md**. Configuração do site: **RENDER-GRATUITO.md**. Checklist de teste: **CHECKLIST-BOTGHOST.md**.

> ⚠️ **Não mexa em nada que já existe no seu bot.** Crie só os itens novos daqui. Não apague, não renomeie e não "sincronize em massa" comandos antigos. Não troque token nem Interactions Endpoint URL. Antes de começar, abra um comando antigo e confira que ele continua funcionando.

**Como ler este manual:**
- Nomes de blocos e opções em **negrito** são os da documentação oficial do BotGhost, por exemplo **Send an API Request**, **Send or Edit a Message**, **Send a Form**, **Comparison Condition**, **Role Condition**, **Hide Replies**, **Hide Option**, **Keep Components**, **Allowed Mentions**, **Manage Secrets** e **Test Request**.
- Se o seu painel mostrar um nome um pouco diferente, use o equivalente.
- Variáveis: **sempre copie pelo ícone de copiar do próprio painel**, em vez de digitar. Os nomes abaixo seguem a documentação (`{nome_do_pedido.response.campo}`, `{nome_do_pedido.status}`, `{nome-do-form.campo}`, `{selected_option}`, `{selected_options}`, `{BGVAR_nome}`). Se o painel mostrar outra forma, vale a do painel.

---

## Parte 0 — Preparação (uma vez)

### 0.1 Segredo da chave do site
1. Gere a chave e coloque no Render (ver RENDER-GRATUITO.md, passo 2).
2. No BotGhost, abra qualquer bloco **Send an API Request** → **Manage Secrets** → crie o segredo `TCEL_SITE_KEY` com a **mesma** chave.
3. Em todo pedido ao site, o cabeçalho é:
   - **HTTP Headers:** `Authorization` = `Bearer ` + (inserir o segredo `TCEL_SITE_KEY` pelo Manage Secrets).
   - **Nunca** coloque essa chave em pedidos para `discord.com`.
   - **Nunca** use `{TOKEN_SECRET}` em pedidos para o site.

### 0.2 Primeiro teste: `/health`
Crie um comando de teste **temporário** (ex.: `/tcel-teste`, visível só para você). Coloque nele um único bloco **Send an API Request**:

| Campo | Valor |
|---|---|
| Nome do pedido | `tcel_health` |
| Method | `GET` |
| URL | `https://SEU-SITE.onrender.com/api/integrations/botghost/health` |
| URL Params | `guildId` = `{server_id}` · `actorDiscordId` = `{user_id}` |
| HTTP Headers | `Authorization` = `Bearer <TCEL_SITE_KEY>` |

1. **Abra o site no navegador antes** (ele dorme no plano gratuito) e aperte **Test Request**.
2. Esperado: status 200 com `"ok": true` e `"code": "healthy"`. Se vier 401, a chave ou o `Bearer ` estão errados. Se não vier nada, o site está dormindo.
3. Depois apague o comando de teste (só ele).

### 0.3 Variáveis personalizadas (estado temporário por operador)
No módulo de variáveis personalizadas, crie estas variáveis de **texto**, com escopo **por usuário**. Cada operador tem o próprio valor, então dois operadores não se atrapalham.

| Variável | Guarda |
|---|---|
| `tcel_student` | ID do aluno entre a escolha de prova e a criação |
| `tcel_name` | nome digitado no formulário |
| `tcel_room_id` | sala a regenerar |
| `tcel_res_student`, `tcel_res_from`, `tcel_res_to` | filtros da consulta |
| `tcel_res_page`, `tcel_res_prev`, `tcel_res_next` | página atual/anterior/próxima da consulta |
| `tcel_draft_id` | rascunho de promoção |
| `tcel_page` | página de candidatos |
| `tcel_next_id`, `tcel_next_name` | próxima pessoa a preencher NOME/ID RP |
| `tcel_review_hash` | revisão a confirmar |
| `tcel_job_id` | lote confirmado |
| `tcel_ann_id` | próximo anúncio a publicar |

- Para gravar, use a ação de definir variável personalizada.
- Para ler, use a forma que o painel copia (pela documentação, `{BGVAR_tcel_draft_id}`).
- O site confere dono, servidor e prazo a cada pedido. Um valor antigo nessas variáveis só gera um erro claro, nunca uma ação em nome de outra pessoa.

### 0.4 Mensagem LOCAL de emergência
Quando o site não responder (dormindo ou reiniciando), o BotGhost mostra este texto fixo, sem depender do site:

> ⏳ Site iniciando. Abra o site, aguarde e tente novamente.

Em todo fluxo, o caminho "else" da primeira condição de status termina com um bloco **Send or Edit a Message** com esse texto (privado).

### 0.5 Dois blocos-padrão de mensagem (reusados em todos os fluxos)

**[MSG-PRIVADA X]** — resposta que só quem clicou vê. Use um **Send or Edit a Message**:
- Tipo: **Reply to the command / event or the most recent interaction**.
- Deixe **Hide Replies** ligado no botão/menu que iniciou o fluxo (é isso que torna a resposta privada).
- **Content:** `{X.response.data.native.content}`
- **Embed** (troque `X` pelo nome do pedido):

| Campo do embed | Valor |
|---|---|
| Title | `{X.response.data.native.title}` |
| Description | `{X.response.data.native.descriptionWithFields}` |
| Color | `{X.response.data.native.color}` |
| Footer | `{X.response.data.native.footerText}` |
| Author, Thumbnail, Image | só se você usar esses campos no modelo |

- Se o modelo não tiver embed (`{X.response.data.native.hideEmbed}` = `true`): use uma **Comparison Condition** antes e, nesse caminho, um bloco só com o Content (**Hide Embed**).
- **Allowed Mentions:** desligue tudo. Respostas privadas não notificam ninguém.
- Alternativa simples, se preferir não ligar campos: Content = `{X.response.data.displayText}`.

**[MSG-CANAL]** — publicar ou editar num canal, a partir de um aviso reservado (`tcel_claim`). **Modo recomendado: pela API do Discord.** Traz o controle exato de quem é notificado e o status do Discord para detectar erro.

- **Enviar** (`action` = `send`) — bloco **Send an API Request** `tcel_send`:
  - Method `POST`, URL `https://discord.com/api/v10/channels/{tcel_claim.response.data.channelId}/messages`
  - HTTP Headers: `Authorization` = `Bot {TOKEN_SECRET}` · `Content-Type` = `application/json`
  - Request Body: **Raw JSON** = `{tcel_claim.response.data.discordBodyJson}`
  - Options: ligue "Replace variables in URL" e "Replace variables in Request Body".
  - Sucesso: `{tcel_send.status}` = 200. ID da mensagem: `{tcel_send.response.id}`.
- **Editar** (`action` = `edit`) — bloco `tcel_edit`: igual, mas Method `PATCH` e URL `https://discord.com/api/v10/channels/{tcel_claim.response.data.channelId}/messages/{tcel_claim.response.data.messageId}`.
  - O corpo não tem botões, então o Discord **mantém** os botões existentes (importante no painel).

> **Validação pendente:** o Raw JSON com uma única variável precisa ser testado com **Test Request** num canal de teste. Veja "Pendências" no fim. Se não funcionar, use o **modo nativo**:
> - **Send or Edit a Message** → envio para canal específico: Channel ID = `{tcel_claim.response.data.channelId}`; campos como no [MSG-PRIVADA]; guarde o ID da mensagem na variável opcional do bloco.
> - Em **Allowed Mentions** avançado, informe os usuários `{tcel_claim.response.data.native.allowedUserIds}` e os cargos `{tcel_claim.response.data.native.allowedRoleIds}`.
> - Para editar: "Edit a specific message" com o Channel ID e o Message ID do claim, e **Keep Components** ligado.

---

## Parte A — Comando `/provatcel` e o painel

1. Crie um **novo** comando personalizado `provatcel` (descrição: "Painel da Prova TCEL"). Restrinja o uso à equipe pela permissão do comando ou por uma **Role Condition** no início.
2. **Send an API Request** `tcel_panel`: `GET …/panel`, URL Params `guildId={server_id}`, `actorDiscordId={user_id}`, `channelId={channel_id}`, `actorDisplayName={user_displayName}`, com o header da chave.
3. **Comparison Condition** `{tcel_panel.status}` igual a `200`:
   - **Sim:** **Send or Edit a Message** no canal onde o comando foi usado, com os campos de [MSG-PRIVADA tcel_panel], mas **público** (sem Hide Replies). Adicione 3 **botões**: `Gerar Prova`, `Conferir resultados` e `Promover`. Em cada botão, se houver a opção de esconder respostas (Hide Replies), **ligue**. Na variável opcional do bloco, guarde o **ID da mensagem** como `tcel_panel_msg`.
     - Em seguida: **Send an API Request** `tcel_panel_reg`: `POST …/panel/register`, Body (chave/valor): identificação + `panelChannelId={channel_id}` + `panelMessageId=` (a variável do ID da mensagem copiada do bloco anterior).
   - **Status 403:** resposta privada `{tcel_panel.response.data.displayText}`.
   - **Outro/sem resposta:** a mensagem LOCAL (0.4).
4. Os fluxos B, C e D ficam **dentro** de cada botão desse bloco.
5. Para trocar o visual do painel depois: aba **Mensagens do Bot** (modelo "Painel") → Publicar. Depois, aba **Integração BotGhost** → **Atualizar painel no Discord**. Isso usa o evento da Parte E.

---

## Parte B — Botão "Gerar Prova"

1. **Role Condition**: cargo da equipe de prova. "Else": resposta privada "Você não tem permissão".
2. **Send a Form** `tcel-gerar` (precisa ser a **primeira resposta** ao clique, por isso vem logo aqui):

| Variável do campo | Rótulo | Tipo | Obrigatório | Tamanho |
|---|---|---|---|---|
| `aluno` | "ID do Discord ou menção do aluno" | curto | sim | — |
| `nome` | "Nome do aluno na prova (opcional)" | curto | não | máx 80 |

3. Depois do envio do formulário: **Send an API Request** `tcel_prep`: `POST …/rooms/prepare`, Body: identificação + `student` = `{tcel-gerar.aluno}`.
4. Defina `tcel_name` = `{tcel-gerar.nome}` e `tcel_student` = `{tcel_prep.response.data.studentDiscordId}`.
5. Condições sobre `tcel_prep`, **nesta ordem**:
   1. `{tcel_prep.status}` = `200` **e** `{tcel_prep.response.data.examChoiceRequired}` = `false` → vá para **B-CRIAR** com `examId` = `{tcel_prep.response.data.examId}`.
   2. `{tcel_prep.status}` = `200` (precisa escolher) → **Send or Edit a Message** privado "Escolha a prova", com um **Select Menu** (Basic/Text, **Single Select**, **Hide Replies** ligado) de **25 opções**. Cada opção N (1 a 25):
      - Label `{tcel_prep.response.data.optNLabel}`
      - Description `{tcel_prep.response.data.optNDescription}`
      - Value `{tcel_prep.response.data.optNValue}`
      - **Hide Option** `{tcel_prep.response.data.optNHide}`

      Ao escolher: **B-CRIAR** com `examId` = `{selected_option}`.
   3. `{tcel_prep.response.code}` = `room_exists` → defina `tcel_room_id` = `{tcel_prep.response.data.roomId}` e responda privado `{tcel_prep.response.message}`, com um botão **"Regenerar links (invalida os anteriores)"** (Hide Replies ligado) → **B-REGENERAR**.
   4. `{tcel_prep.status}` = `400`, `403` ou `409` → privado `{tcel_prep.response.data.displayText}`.
   5. Senão → mensagem LOCAL.

**B-CRIAR** (bloco repetido nos dois caminhos acima) — **Send an API Request** `tcel_room`: `POST …/rooms`, Body: identificação + `student` = `{BGVAR_tcel_student}` + `studentDisplayName` = `{BGVAR_tcel_name}` + `examId` (conforme o caminho) + `idempotencyKey` = `{interaction_id}`.

| Resultado | O que fazer |
|---|---|
| `{tcel_room.status}` = `201` | [MSG-PRIVADA tcel_room]. Os links vão só aqui, para o operador. **Nunca** repasse o link de fiscal ao aluno. Mande ao aluno só o link do aluno, você mesmo, por DM. |
| `{tcel_room.response.code}` = `room_exists` | Igual ao item 3 acima (botão Regenerar) |
| Outro status com resposta | Privado `{tcel_room.response.data.displayText}` |
| Sem resposta | Mensagem LOCAL |

**B-REGENERAR** — **Send an API Request** `tcel_regen`: `POST …/rooms/{BGVAR_tcel_room_id}/regenerate-links` (ligue "Replace variables in URL"), Body: identificação + `idempotencyKey` = `{interaction_id}`.
- 200 → [MSG-PRIVADA tcel_regen].
- Senão → `{tcel_regen.response.data.displayText}` ou a mensagem LOCAL.

---

## Parte C — Botão "Conferir resultados"

1. **Role Condition** (equipe).
2. **Send a Form** `tcel-filtro` (primeira resposta), todos os campos **opcionais**:

| Variável | Rótulo |
|---|---|
| `aluno` | "ID ou menção (vazio = todos)" |
| `de` | "Desde (DD/MM/AAAA)" |
| `ate` | "Até (DD/MM/AAAA)" |

3. Defina `tcel_res_student` = `{tcel-filtro.aluno}`, `tcel_res_from` = `{tcel-filtro.de}`, `tcel_res_to` = `{tcel-filtro.ate}`, `tcel_res_page` = `0`.
4. **C-BUSCAR** — **Send an API Request** `tcel_res`: `GET …/results`, URL Params: identificação + `student` = `{BGVAR_tcel_res_student}` + `from` = `{BGVAR_tcel_res_from}` + `to` = `{BGVAR_tcel_res_to}` + `page` = `{BGVAR_tcel_res_page}` + `pageSize` = `10`. Ligue "Automatically exclude empty fields", se existir.
5. `{tcel_res.status}` = `200`:
   - Defina `tcel_res_prev` = `{tcel_res.response.data.previousPage}` e `tcel_res_next` = `{tcel_res.response.data.nextPage}`.
   - [MSG-PRIVADA tcel_res] com 3 botões (Hide Replies ligado): **◀ Anterior**, **🔄 Atualizar** e **Próxima ▶**.
   - Senão: `displayText` ou a mensagem LOCAL.
6. Cada botão:
   1. Define `tcel_res_page`: Anterior = `{BGVAR_tcel_res_prev}`; Próxima = `{BGVAR_tcel_res_next}`; Atualizar mantém.
   2. Repete o **C-BUSCAR**.
   3. Mostra o resultado. Prefira **editar a mensagem anterior** ("Edit a previous message from another action in the tree", com **Keep Components**) para os botões continuarem valendo. Se não der, responda com uma nova mensagem privada.

   O site limita a página: "Próxima" na última página devolve a última de novo.

---

## Parte D — Botão "Promover"

Promoção mexe em cargos reais. **Monte e teste primeiro com um membro de teste e cargos de teste** (ver CHECKLIST-BOTGHOST.md). Só depois troque para os cargos reais, na aba Integração do site.

### D1. Abrir o rascunho e selecionar
1. **Role Condition** (equipe que promove).
2. **Send an API Request** `tcel_draft`: `POST …/promotion-drafts`, Body: identificação.
3. Se `{tcel_draft.status}` = `200` ou `201`: defina `tcel_draft_id` = `{tcel_draft.response.data.draftId}`, `tcel_page` = `{tcel_draft.response.data.page}`, `tcel_next_id` = `{tcel_draft.response.data.nextDiscordUserId}` e `tcel_next_name` = `{tcel_draft.response.data.nextStudentName}`. Senão: `displayText` ou LOCAL.
4. [MSG-PRIVADA tcel_draft] com:
   - **Select Menu dinâmico** (Basic/Text, **Multi Select**, mín 0, máx 25, Hide Replies ligado), 25 opções ligadas a `{tcel_draft.response.data.optNLabel/Description/Value}` e **Hide Option** `{…optNHide}`.
     - Ao escolher → **Send an API Request** `tcel_sel`: `POST …/promotion-drafts/{BGVAR_tcel_draft_id}/selection`, Body: identificação + `page` = `{BGVAR_tcel_page}` + `attemptIds` = `{selected_options}`.
     - Depois: atualize `tcel_next_id`/`tcel_next_name` com `{tcel_sel.response.data.nextDiscordUserId}` / `{…nextStudentName}` e responda privado `{tcel_sel.response.data.displayText}`.
   - **Alternativa ou complemento** — um **Select Menu do tipo User** (Multi Select) → `tcel_sel` com `discordUserIds` = `{selected_options}` em vez de `attemptIds`. O site valida **todos** os escolhidos antes de aceitar.
   - Botões (Hide Replies ligado): **Preencher próximo**, **Revisar**, **Executar / continuar lote**, **Cancelar**.
   - Mais de 25 candidatos: filtre com o menu de usuários, ou faça um botão "Página ▶" que define `tcel_page` = `{tcel_draft.response.data.nextPage}`, chama `GET …/promotion-drafts/{BGVAR_tcel_draft_id}?page={BGVAR_tcel_page}` e mostra de novo o mesmo menu. É preciso copiar o bloco do menu. As marcações das outras páginas são mantidas pelo site.

### D2. "Preencher próximo" (NOME RP / ID RP)
1. **Send a Form** `tcel-rp` (primeira resposta do clique):

| Variável | Rótulo | Detalhes |
|---|---|---|
| `nome` | "NOME RP de {BGVAR_tcel_next_name}" | curto, obrigatório, máx 32 |
| `idrp` | "ID RP (zeros à esquerda são mantidos)" | curto, obrigatório, máx 16 |

2. **Send an API Request** `tcel_rp`: `POST …/promotion-drafts/{BGVAR_tcel_draft_id}/members`, Body: identificação + `member` = `{BGVAR_tcel_next_id}` + `nomeRP` = `{tcel-rp.nome}` + `idRP` = `{tcel-rp.idrp}`.
3. `200`: atualize `tcel_next_id`/`tcel_next_name` com `{tcel_rp.response.data.nextDiscordUserId}` / `{…nextStudentName}`. Responda privado: `Apelido: {tcel_rp.response.data.nickname}. Próximo: {tcel_rp.response.data.nextMention}`.
4. `422` (`rp_invalid`, por exemplo apelido com mais de 32 caracteres): privado `{tcel_rp.response.message}`. Clique **Preencher próximo** de novo para corrigir.
5. **Não** abra outro formulário direto daqui: o Discord não permite formulário como resposta de formulário. O operador clica "Preencher próximo" de novo na mensagem do D1.

### D3. "Revisar" e "Confirmar"
1. "Revisar" → **Send an API Request** `tcel_review`: `POST …/promotion-drafts/{BGVAR_tcel_draft_id}/review`, Body: identificação.
2. Defina `tcel_review_hash` = `{tcel_review.response.data.reviewHash}`.
3. [MSG-PRIVADA tcel_review].
4. Se `{tcel_review.response.data.canConfirm}` = `true`: inclua o botão **"Confirmar promoção"** (Hide Replies ligado).
5. "Confirmar promoção" → **Send an API Request** `tcel_confirm`: `POST …/promotion-drafts/{BGVAR_tcel_draft_id}/confirm`, Body: identificação + `reviewHash` = `{BGVAR_tcel_review_hash}` + `idempotencyKey` = `{interaction_id}`.

| Resultado | O que fazer |
|---|---|
| `201` (ou `{tcel_confirm.response.code}` = `already_confirmed`) | Defina `tcel_job_id` = `{tcel_confirm.response.data.jobId}`. Responda "Confirmado. Clique em **Executar / continuar lote**." |
| `409` `changed_since_review` | Mostre `{tcel_confirm.response.data.displayText}` (a revisão nova) e peça para revisar/confirmar de novo |

### D4. "Executar / continuar lote" — uma pessoa por clique
Cada clique processa **uma** pessoa e mostra o resultado. O operador clica de novo até terminar. Não há laço automático: cada passo fica visível e pode ser interrompido com segurança.

1. **Send an API Request** `tcel_job`: `POST …/promotion-jobs/{BGVAR_tcel_job_id}/claim`, Body: identificação.
   - Status diferente de 200 → `displayText` (ex.: `job_locked` = outra execução em andamento) ou LOCAL.
2. Se `{tcel_job.response.data.hasItem}` = `false` → vá para **D5 (anúncio)**.
3. **Ler o membro** — **Send an API Request** `tcel_mb`:
   - Method `GET`, URL `https://discord.com/api/v10/guilds/{server_id}/members/{tcel_job.response.data.memberDiscordId}`
   - Header `Authorization` = `Bot {TOKEN_SECRET}`
4. **Pré-verificação** — **Send an API Request** `tcel_pre`: `POST …/promotion-jobs/{BGVAR_tcel_job_id}/progress`, Body:

| Campo | Valor |
|---|---|
| identificação | (os 4 campos de sempre) |
| `leaseToken` | `{tcel_job.response.data.leaseToken}` |
| `memberDiscordId` | `{tcel_job.response.data.memberDiscordId}` |
| `phase` | `precheck` |
| `memberStatus` | `{tcel_mb.status}` |
| `roleIds` | `{tcel_mb.response.roles}` |
| `nickname` | `{tcel_mb.response.nick}` |

   - Se vier `{tcel_pre.response.code}` = `evidence_unreadable`, a lista de cargos não veio legível. Troque este fluxo para o **modo status**: `evidenceMode` = `status` e sem `roleIds`/`nickname` (ver BOTGHOST-API.md §7).
   - Se `{tcel_pre.response.data.itemStatus}` for diferente de `in_progress` (ex.: `completed`, `failed`, `needs_review`): responda privado `{tcel_pre.response.data.displayText}` e pare (clique de novo para a próxima pessoa).
5. **Ações no Discord** (só quando o slot não está vazio; uma **Comparison Condition** por slot):

| Se… não estiver vazio | Pedido | Method | URL (base `https://discord.com/api/v10/guilds/{server_id}/members/{tcel_job.response.data.memberDiscordId}`) |
|---|---|---|---|
| `{tcel_pre.response.data.addRole1}` | `tcel_add1` | `PUT` | `…/roles/{tcel_pre.response.data.addRole1}` |
| `{tcel_pre.response.data.addRole2}` | `tcel_add2` | `PUT` | `…/roles/{tcel_pre.response.data.addRole2}` |
| `{tcel_pre.response.data.removeRole1}` | `tcel_rem1` | `DELETE` | `…/roles/{tcel_pre.response.data.removeRole1}` |
| `{tcel_pre.response.data.needNickname}` = `true` | `tcel_nick` | `PATCH` | a própria base, Body (chave/valor) `nick` = `{tcel_pre.response.data.expectedNickname}` |

   - Em todos: Header `Authorization` = `Bot {TOKEN_SECRET}`.
   - Crie um bloco por cargo configurado. Com os valores iniciais são 2 a adicionar e 1 a remover; se o admin configurar mais, some `addRole3` etc. até 5.
   - Discord responde 204 para cargo e 200 para apelido quando dá certo. Adicionar um cargo que já existe ou tirar um que não existe também dá certo, então repetir é seguro.
6. **Ler de novo** — **Send an API Request** `tcel_mb2` (igual ao passo 3).
7. **Relatar o resultado** — **Send an API Request** `tcel_post`: `…/progress` com `phase` = `result`, `memberStatus` = `{tcel_mb2.status}`, `roleIds` = `{tcel_mb2.response.roles}`, `nickname` = `{tcel_mb2.response.nick}`, `actionError` = `add1={tcel_add1.status} add2={tcel_add2.status} rem1={tcel_rem1.status} nick={tcel_nick.status}`.
   - No **modo status**, mande `evidenceMode` = `status` e `statusReport` com esse mesmo texto.
8. Resposta privada `{tcel_post.response.data.displayText}`. Defina `tcel_ann_id` = `{tcel_post.response.data.nextAnnouncementId}`.
9. Se `{tcel_post.response.data.jobDone}` = `true` → mostre o resultado final (`[MSG-PRIVADA tcel_post]`: modelo "Promoção concluída" ou "Falha parcial") e o botão **"📣 Publicar anúncio"**.

**Falhou alguém?** Na aba Integração do site, o admin clica **Retomar pendentes**. Depois o operador clica de novo em "Executar / continuar lote": só as etapas que faltam são refeitas.

### D5. "📣 Publicar anúncio"
1. Se `tcel_ann_id` estiver vazio: chame `GET …/promotion-jobs/{BGVAR_tcel_job_id}` e use `{…data.nextAnnouncementId}`.
2. **Send an API Request** `tcel_claim`: `POST …/notifications/{BGVAR_tcel_ann_id}/claim` → **[MSG-CANAL]** → **ack** (igual à Parte E, passos 4–5).
3. Repita enquanto `announcementPendingCount` > 0 (lotes grandes têm várias partes, até 40 pessoas cada).
4. Se você não publicar, o **webhook** publica sozinho depois de ~2 minutos (se os avisos estiverem ligados). O site não deixa sair duas vezes.

---

## Parte E — Evento de webhook: avisos do site

Serve para: aviso de prova finalizada, nota editada/removida, anúncio de promoção, teste de mensagem e atualização do painel.

1. No módulo **Webhooks**, crie o evento `TCEL avisos`.
   - Copie a **URL** (`https://api.botghost.com/webhook/<bot>/<evento>`) para `BOTGHOST_WEBHOOK_URL` no Render.
   - Copie a **API Key** do módulo para `BOTGHOST_WEBHOOK_API_KEY`. Ela **não** é o token do Discord.
2. Crie um **Custom Event** do tipo webhook, apontando para esse evento. Defina o **servidor base** (o servidor da TCEL).
3. O site manda as variáveis `{tcel_notification_id}` e `{tcel_notification_kind}`.
4. Blocos:
   1. **Send an API Request** `tcel_claim`: `POST https://SEU-SITE.onrender.com/api/integrations/botghost/notifications/{tcel_notification_id}/claim` (header da chave; "Replace variables in URL" ligado; sem body).
   2. **Comparison Condition** `{tcel_claim.status}` = `200`. **Senão: fim** (não publique nada; o site decide).
   3. **Comparison Condition** `{tcel_claim.response.data.action}` = `edit`:
      - **Sim:** `tcel_edit` (ver [MSG-CANAL]).
        - Se `{tcel_edit.status}` = `200` → `tcel_ack` com `messageId` = `{tcel_claim.response.data.messageId}`.
        - Senão → `tcel_ack` com falha.
      - **Não:** `tcel_send`.
        - Se `{tcel_send.status}` = `200` → `tcel_ack` com `messageId` = `{tcel_send.response.id}`.
        - Senão → `tcel_ack` com falha.
5. **Send an API Request** `tcel_ack`: `POST …/notifications/{tcel_notification_id}/ack`, Body (chave/valor):
   - Sucesso: `leaseToken` = `{tcel_claim.response.data.leaseToken}`, `outcome` = `delivered`, `messageId` = (conforme acima), `channelId` = `{tcel_claim.response.data.channelId}`.
   - Falha: `outcome` = `failed`, `error` = `HTTP {tcel_send.status}` (ou `{tcel_edit.status}`).

**Ligar os avisos:** só depois de montar este evento, coloque `BOTGHOST_NOTIFICATIONS_ENABLED=true` no Render. Até lá, os avisos ficam guardados na fila do site; nada se perde.

---

## Recuperação de erros (o que fazer quando…)

| Situação | O que aparece | O que fazer |
|---|---|---|
| Site dormindo | Mensagem LOCAL | Abrir o site no navegador, esperar carregar, clicar de novo |
| Operador não autorizado | "Você não está autorizado…" | Admin adiciona o ID na aba Integração |
| Clique duplo / repetido | "já criou a sala" / "já confirmada" | Nada: nada foi repetido |
| Sala já aberta | Botão Regenerar | Regenerar invalida os links anteriores |
| Rascunho expirou (1 h) | "rascunho expirou" | Clicar Promover de novo (nenhum membro foi alterado) |
| Nota mudou antes de confirmar | Revisão nova | Revisar e confirmar de novo |
| Cargo acima do bot / sem permissão | Pessoa "parcial", erro HTTP 403 | Subir o cargo do bot, admin "Retomar pendentes", clicar Executar |
| Membro saiu | Pessoa "falhou" | Nada a fazer; a pessoa fica liberada |
| Já tinha os cargos | "precisa de revisão" | Admin confere e clica "Aceitar estado atual" |
| Aviso "ambíguo" | Aba Integração | Conferir o canal: "Já está no canal" (com o ID) ou "Reenviar" |
| Webhook 401/404 | Aba Integração (erro do webhook) | Conferir URL/API Key do módulo Webhooks no Render |

---

## Pendências de validação (não dá para confirmar sem o seu painel)

Nada disto foi testado num BotGhost real: o site foi testado com um BotGhost **simulado** (mesmos pedidos HTTP). Teste cada item no servidor de teste antes de usar de verdade:

1. **Módulo Webhooks no seu plano.** A documentação não diz que é pago. Se o seu plano não tiver, os avisos ficam **pendentes**: deixe `BOTGHOST_NOTIFICATIONS_ENABLED=false`. Nesse caso o anúncio de promoção ainda sai pelo botão "Publicar anúncio" (D5), mas o aviso automático de "prova finalizada" não sai. Nada é trocado por outro serviço.
2. **Raw JSON com uma variável só** (`{…discordBodyJson}`) no modo API do [MSG-CANAL]. Teste com Test Request apontando para o canal de teste. Se falhar, use o modo nativo.
3. **Lista de cargos do membro** (`{tcel_mb.response.roles}`). A documentação diz que só texto e número voltam. Se o site responder `evidence_unreadable`, use o modo status.
4. **Menu dinâmico:** variáveis nos campos das opções e no **Hide Option** (a documentação diz que funciona). Confira com 2–3 provas/candidatos.
5. **Respostas privadas** depois de formulário e em botões (Hide Replies).
6. **Botões do painel** funcionando dias depois de publicados.
7. **O que o BotGhost faz com o site dormindo** (tempo de espera do pedido). Garanta que o "else" mostra a mensagem LOCAL.
8. **Quebras de linha** vindas de variáveis no Content/Description nativos.
9. **Editar a mensagem anterior** na paginação de resultados.
10. **Prova ponta a ponta de embed no Discord real:** feita só com dados simulados (prévia e teste automatizado). Use **Enviar teste** na aba Mensagens do Bot com o canal de teste configurado.
