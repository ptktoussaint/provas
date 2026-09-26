# API do site para o BotGhost — referência

Este é o "cardápio" de pedidos que o bot do **BotGhost** pode fazer ao site da Prova TCEL, e o formato das respostas. O passo a passo de montagem dos fluxos no painel do BotGhost está em **BOTGHOST-MONTAGEM.md**. A configuração do Render está em **RENDER-GRATUITO.md**.

> **Teste primeiro o `/health`.** Antes de montar qualquer fluxo, crie só o pedido de saúde (seção 3) e aperte **Test Request** no BotGhost. Se ele não responder `"ok": true`, nada mais vai funcionar.

---

## 1. Como a integração funciona

```
Discord ──(comando/botão/formulário)──► BotGhost ──HTTPS + chave do site──► Site (Render)
                                            ▲                                     │
                                            └──── webhook oficial do BotGhost ◄───┘
                                                  (só o ID do aviso)
```

- **O BotGhost** continua sendo o bot: recebe o `/provatcel`, mostra botões e formulários, confere cargos, dá/tira cargos, muda apelidos e publica mensagens.
- **O site** cria salas e links, guarda as notas oficiais, controla rascunhos e lotes de promoção e guarda cada aviso numa fila no MongoDB.
- **BotGhost → site:** pedidos HTTPS com a **chave do site** (`BOTGHOST_SITE_API_KEY`).
- **Site → BotGhost:** o **Webhook oficial** do BotGhost (módulo Webhooks), autenticado com a **API Key do módulo Webhooks**. O site manda só o ID do aviso. O evento do BotGhost pede o conteúdo atual ao site (`claim`), publica e confirma (`ack`).
- O site **nunca** conecta no Discord e **nunca** recebe o token do bot. O `{TOKEN_SECRET}` só existe dentro do BotGhost, e só nos pedidos para `discord.com`.

São três segredos diferentes. Não confunda:

| Segredo | Onde fica | Para quê |
|---|---|---|
| `BOTGHOST_SITE_API_KEY` | Render (Environment) **e** BotGhost (Manage Secrets) | O BotGhost provar ao site que é ele |
| `BOTGHOST_WEBHOOK_API_KEY` | Só no Render | O site disparar o webhook do BotGhost |
| Token do bot (`{TOKEN_SECRET}`) | Só no BotGhost | O BotGhost falar com a API do Discord |

---

## 2. Regras que valem para todos os pedidos

**Endereço base:** `https://SEU-SITE.onrender.com/api/integrations/botghost`. O endereço exato aparece na aba **Integração BotGhost** do painel admin.

**Cabeçalho obrigatório (HTTP Headers):**

| Key | Value |
|---|---|
| `Authorization` | `Bearer ` + o segredo da chave do site, inserido pelo botão **Manage Secrets** |

- Não cole a chave no campo como texto. Use **Manage Secrets**, para ela não aparecer no bloco.
- Depois de `Bearer` vem **um espaço**.

**Identificação de quem clicou.** Vai em URL Params nos pedidos GET e no Request Body nos pedidos POST. Os valores vêm **sempre** das variáveis da interação real, nunca de campos digitados:

| Campo | Valor no BotGhost |
|---|---|
| `guildId` | `{server_id}` |
| `actorDiscordId` | `{user_id}` |
| `channelId` | `{channel_id}` |
| `actorDisplayName` | `{user_displayName}` |

**Request Body:** use o modo **chave/valor** (key-value) do Request Builder, e não o "Raw JSON". Assim o próprio BotGhost monta o JSON, e um nome com aspas não quebra o pedido. Todo valor vai como **texto**. IDs do Discord **nunca** vão como número: o site recusa, porque número perde dígitos.

**Chave de repetição (`idempotencyKey`).** Obrigatória nos pedidos que criam algo (sala, regenerar links, confirmar promoção). Use `{interaction_id}`: é o mesmo durante toda a execução daquele clique ou formulário.
- Se o mesmo pedido chegar duas vezes, o site devolve a mesma resposta sem repetir a ação.
- Mesma chave com conteúdo diferente dá `idempotency_conflict`.
- Um clique novo gera `{interaction_id}` novo. Não invente outra variável.

**Formato de toda resposta:**

```json
{ "ok": true, "code": "room_created", "message": "texto curto", "data": { "displayText": "...", "...": "..." } }
```

- `{nome_do_pedido.status}` dá o status HTTP (200, 201, 403, 409…).
- `{nome_do_pedido.response.ok}` vale `true` ou `false`.
- `{nome_do_pedido.response.code}` traz o código estável para usar em condições.
- `{nome_do_pedido.response.data.displayText}` **sempre existe**: é um texto pronto para mostrar quando não houver algo melhor.
- Os valores em `data` são texto ou número. Sim/não vem como o texto `"true"` / `"false"`, próprio para **Comparison Condition**.

**Mensagem pronta (`data.message`, `data.native`, `data.discordBodyJson`).** Os pedidos que mostram algo ao operador ou a um canal devolvem a mensagem já montada com o modelo da aba **Mensagens do Bot**:
- `data.native.*` — campos soltos para ligar nos blocos nativos: `content`, `title`, `description`, `descriptionWithFields` (descrição + campos num texto só), `color` (decimal), `colorHex`, `authorName`, `authorUrl`, `authorIconUrl`, `thumbnailUrl`, `imageUrl`, `footerText`, `footerIconUrl`, `timestamp` (ISO), `url`, `hideEmbed` (`"true"` quando o modelo não usa embed), `allowedUserIds` e `allowedRoleIds` (IDs separados por vírgula, para o "Allowed Mentions" avançado).
- `data.discordBodyJson` — o corpo pronto para a API do Discord (`POST /channels/{id}/messages`, `PATCH .../messages/{id}`). Traz `allowed_mentions` explícito. As chaves `{ }` dentro dos textos vão escapadas (`{`), para o BotGhost não confundir com variáveis.
- `data.discordCallbackJson` — só nas mensagens privadas. É o corpo de resposta de interação (tipo 4, `flags: 64` = só quem clicou vê). **Validação pendente** (ver BOTGHOST-MONTAGEM.md, "Pendências").

**Nunca vêm na resposta:** gabarito, respostas do aluno, hashes, chaves ou tentativas inteiras. Links de prova só vêm em **uma** resposta: a de criação/regeneração da sala.

**Erros comuns (valem para qualquer rota):**

| status | code | O que fazer |
|---|---|---|
| 401 | `unauthorized` | Chave errada/ausente. Confira o segredo e o `Bearer `. |
| 503 | `integration_disabled` / `integration_not_configured` | Integração desligada ou variável faltando no Render. |
| 403 | `guild_not_allowed` / `wrong_channel` / `operators_not_configured` / `operator_not_allowed` | Negado. Mostre `data.message` (modelo "Acesso negado") ou `message`. |
| 400 | `invalid_field` / `invalid_user` / `invalid_json` | Campo inválido. `data.field` diz qual. |
| 413 | `payload_too_large` | Pedido grande demais (limite 32 KB). |
| 429 | `rate_limited` | Muitos pedidos. Espere alguns segundos. |
| sem resposta / tempo esgotado | — | O site está dormindo (Render gratuito). Mostre a mensagem **local**: "Site iniciando. Abra o site, aguarde e tente novamente". |

---

## 3. Saúde — `GET /health`

Teste este **primeiro**.

- **Nome do pedido:** `tcel_health`
- **Method:** GET · **URL:** `…/api/integrations/botghost/health`
- **URL Params (opcionais):** `guildId={server_id}`, `actorDiscordId={user_id}`
- **Headers:** `Authorization: Bearer <segredo>`

Resposta 200:

| Variável | Conteúdo |
|---|---|
| `{tcel_health.response.code}` | `healthy` |
| `{tcel_health.response.data.canGenerate}` | `true`/`false` (com os params) |
| `{tcel_health.response.data.canResults}` | idem |
| `{tcel_health.response.data.canPromote}` | idem |
| `{tcel_health.response.data.notificationsEnabled}` | avisos por webhook ligados |

---

## 4. Painel

### `GET /panel`
Devolve o conteúdo atual do painel (modelo "Painel /provatcel"). Aceita qualquer operador de qualquer ação.
- **URL Params:** `guildId`, `actorDiscordId`, `channelId`, `actorDisplayName`
- **Resposta:** `data.native.*`, `data.message`, `data.discordBodyJson`

### `POST /panel/register`
Registra a mensagem do painel depois de publicada. Assim o botão **Atualizar painel no Discord** do admin consegue editá-la.
- **Body:** identificação + `panelChannelId` (canal onde publicou) + `panelMessageId` (ID da mensagem guardado pelo bloco de envio)
- **Resposta:** `code = panel_registered`

---

## 5. Gerar prova

> **Prova fixa do fluxo TCEL.** Este fluxo (`/provas-tcel`) usa **sempre** a prova de identificador (slug) `tcel` — o `examId` enviado é ignorado e provas DAFP nunca aparecem aqui. Se a prova `tcel` estiver desativada ou sem questões, a resposta é `409 exam_not_eligible` (nenhuma outra prova é aberta). O novo fluxo **DAFP** (`/provas-dafp`) tem rotas próprias (`/dafp/*`): ver **BOTGHOST_DAFP_IMPLEMENTACAO.md**.

### `GET /exams`
Provas aptas (ativas e com questões ativas).
- **URL Params:** identificação
- **Resposta:** `examCount`, `defaultExamId`, `choiceRequired` (`"true"` = há várias e nenhuma padrão), `displayText` (lista) e **25 opções prontas para um menu de seleção**: `opt1Label` … `opt25Label`, `optNDescription`, `optNValue` (ID da prova), `optNHide` (`"true"` nas que sobram), `optNDefault`.

### `POST /rooms/prepare` (não cria nada)
Interpreta o ID ou menção digitada e avisa se precisa escolher a prova ou se já existe sala aberta. Também serve para "acordar" o site.
- **Body:** identificação + `student` (ID ou `<@ID>`) + `supervisorDiscordId` (opcional, ID ou `<@ID>` do fiscal) + `examId` (opcional)
- **200 `ready`:** `studentDiscordId`, `studentMention`, `supervisorDiscordId`, `supervisorMention`, `examChoiceRequired`, `examId`, `examName`, `examListText`, `opt1…opt25*`
- **409 `room_exists`:** `roomId`, `roomLabel`, `roomCode`, `supervisorDiscordId` (fiscal da sala aberta, se houver), `canRegenerate = "true"`
- **409 `no_eligible_exam` / `exam_not_eligible`**, **400 `invalid_user`**, **400 `supervisor_is_student`** (o fiscal escolhido é o próprio aluno)

### `POST /rooms` (cria a sala)
- **Body:**
  - identificação (`guildId`, `actorDiscordId`, `actorDisplayName`, `channelId`) — **quem clicou** (operador)
  - `student` — **aluno** (ID ou `<@ID>`)
  - `studentDisplayName` (opcional) — nome que aparece na prova
  - `supervisorDiscordId` (opcional) — **fiscal** escolhido no formulário (ID ou `<@ID>`, sempre entre aspas)
  - `supervisorDisplayName` (opcional) — nome do fiscal; vazio ou variável não substituída → `Fiscal 1234` (final do ID)
  - `studentAvatarUrl` (opcional) — foto do aluno, ver "Foto do aluno" abaixo
  - `examId` (opcional) + `idempotencyKey = {interaction_id}`
- **Três papéis diferentes:** `actorDiscordId` (quem clicou), `student` (aluno) e `supervisorDiscordId` (fiscal). Podem ser três pessoas. O operador pode ser o próprio fiscal; o aluno não (**400 `supervisor_is_student`**). O fiscal **não** precisa estar na lista de operadores: ele não chama a API, só usa o link.
- **201 `room_created`:** `roomId`, `roomLabel`, `roomCode`, `examName`, `studentDiscordId`, `studentAvatarSaved` (`"true"`/`"false"`), `supervisorDiscordId`, `supervisorDisplayName`, `supervisorMention`, `supervisorSelected` (`"true"` = fiscal escolhido no formulário), **`studentUrl`**, **`supervisorUrl`**, `linksAvailable = "true"`, e a mensagem privada pronta (`data.native.*`, modelo "Sala criada", com o campo **Fiscal**).
  - `studentUrl` → link do **aluno**. `supervisorUrl` → link de **fiscal** do fiscal escolhido. Sem `supervisorDiscordId` (fluxo antigo), o link de fiscal continua sendo do operador que clicou e `supervisorDiscordId` volta vazio.
  - O vínculo fica gravado na sala e é copiado para a tentativa quando o aluno começa a prova: continua no resultado mesmo depois de a sala ser encerrada ou excluída. Cada sala (e cada tentativa) guarda o seu fiscal: a segunda prova do mesmo aluno tem o fiscal escolhido para ela.
  - **Mostre só em resposta privada ao operador.** O site nunca publica links em canal. Nunca mande o link de fiscal ao aluno; repasse ao fiscal em privado.
  - Abrir o link não prova identidade: quem tiver o link entra.
- **Foto do aluno (`studentAvatarUrl`):** o site **não tem** token do Discord (e não deve ter), então não consegue buscar a foto sozinho. O BotGhost pode mandar a URL na criação da sala (variável `{user_icon[...]}` do BotGhost, com o ID do aluno como alvo). O site só guarda URL **HTTPS** do CDN do Discord (`cdn.discordapp.com` ou `media.discordapp.net`) cujo caminho tem o **ID do próprio aluno** (ou o avatar padrão `embed/avatars/N.png`). Qualquer outra coisa é descartada (`studentAvatarSaved = "false"`), sem impedir a sala. Sem foto válida, `resultStudentAvatarUrl` volta vazio. Se o aluno trocar a foto depois, a URL antiga pode parar de abrir.
- **Repetição (mesma `idempotencyKey`):** 200 `room_already_created`, `replayed = "true"`, `linksAvailable = "false"`. **Sem links**: o site não guarda links para reexibir. Para links novos, use regenerar.
- **409 `room_exists`:** já há sala aberta para esse aluno nessa prova. Ofereça **Regenerar links** com `roomId`.
- **422 `exam_choice_required`:** várias provas e nenhuma padrão. A resposta traz as opções `opt*`; mostre o menu e chame de novo com `examId`.

### `POST /rooms/{roomId}/regenerate-links`
Gera **novos** links: um do aluno e um de fiscal **para o fiscal escolhido na criação da sala** (quem clicou em Regenerar não vira fiscal). Em salas criadas sem fiscal (fluxo antigo), o link de fiscal é de quem clicou, como antes. **Os anteriores param de funcionar.** Quem já está na prova não cai. Não cria sala nova.
- **Body:** identificação + `idempotencyKey = {interaction_id}`
- **200 `links_regenerated`:** `studentUrl`, `supervisorUrl`, `supervisorDiscordId`, `supervisorDisplayName`, `supervisorMention`, `supervisorSelected`, mensagem pronta
- **409 `regenerate_too_soon`:** acabou de gerar. Use os links já mostrados.
- **409 `room_closed`**, **404 `room_not_found`**

---

## 6. Conferir resultados — `GET /results`

Só resultados de provas **TCEL** (resultados DAFP ficam em `GET /dafp/results`). Os candidatos da promoção também são só TCEL.

Lê o banco **na hora**. Mensagens já mostradas no Discord são "fotos" do momento e não se atualizam sozinhas: use o botão "Atualizar".
- **URL Params:** identificação + (opcionais) `student` (ID/menção), `examId`, `from` e `to` (`AAAA-MM-DD` ou `DD/MM/AAAA`, horário de Brasília), `sort` (`date-desc` padrão, `date-asc`, `score-desc`, `score-asc`), `page` (começa em 0), `pageSize` (1–25, padrão 10)
- **Resposta (`results` ou `results_empty`):** `total`, `page`, `pageNumber`, `pages`, `hasPrevious`, `hasNext`, `previousPage`, `nextPage`, `filterText`, `displayText`, `items` (lista resumida) e a mensagem pronta (modelos "Consulta de resultados" / "Lista vazia").
  - Em cada item: `score` (nota final), `writtenScore` (prova escrita), `oralScore` (número ou vazio) e `hasOral`. Com prova oral, a linha mostra "Prova (X) + Prova Oral (Y) = Z".
  - Também em cada item (texto pronto): `studentAvatarUrl`, `supervisorDiscordId`, `supervisorDisplayName`, `supervisorMention`, `supervisorsText`, `examScore`, `examMaxScore`, `oralScoreText`, `oralPending`, `totalScore`, `scoreText`.
- Resultados **arquivados** pelo admin não aparecem aqui nem nos candidatos à promoção.
- Se a página não couber numa mensagem do Discord, o site devolve menos itens por página. Ele **nunca corta** uma linha no meio.
- Nenhum link ou token de prova aparece em `/results`.

### 6.1 Campos separados da prova da página (para montar o seu embed)

Sempre presentes em `response.data`. Preenchidos **só quando a página tem exatamente uma prova** (ex.: `pageSize = 1`); com 0 ou várias provas na página, ficam vazios e `resultSingle = "false"` (cada item de `items` tem os seus). Como vêm da própria prova da página, mudam junto em **Anterior / Próxima / Atualizar**: nunca são de outra página nem de quem clicou. Use direto `{tcel_res.response.data.resultX}`; **não** guarde em variável personalizada para reaproveitar em outra página.

| Campo | O que é |
|---|---|
| `resultSingle` | `"true"` quando a página tem exatamente uma prova |
| `resultAttemptId`, `resultExamName`, `resultFinishedAt` | Tentativa, nome da prova, data de término (DD/MM/AAAA) |
| `resultStudentDiscordId` | ID do aluno (vazio se o resultado não está vinculado ao Discord) |
| `resultStudentDisplayName` | Nome do aluno na prova |
| `resultStudentMention` | `<@ID>` do aluno (vazio se sem vínculo) |
| `resultStudentAvatarUrl` | Foto do aluno (URL HTTPS) enviada na criação da sala; vazio se não houver |
| `resultSupervisorDiscordId` | ID do fiscal principal (o escolhido no formulário); vazio em resultados antigos |
| `resultSupervisorDisplayName` | Nome do fiscal principal. Em resultados antigos: o(s) nome(s) de fiscal registrado(s), sem ID |
| `resultSupervisorMention` | `<@ID>` do fiscal principal; vazio em resultados antigos |
| `resultSupervisorsText` | Todos os fiscais, um por linha: `⭐ <@ID> — Nome (principal, escolhido no Discord)` e depois `• Nome` de cada outro fiscal que se conectou |
| `resultExamScore` | Nota da prova (escrita) |
| `resultExamMaxScore` | Pontuação máxima da prova (questões × pontos por questão) |
| `resultOralScore` | Nota da prova oral, ou `Pendente` |
| `resultOralPending` | `"true"` enquanto a oral não foi lançada |
| `resultTotalScore` | Prova + oral, ou `Pendente` enquanto a oral não foi lançada |
| `resultScoreText` | `Prova: X \| Prova oral: Y \| Total: Z` |

**Regras das notas (como o site calcula hoje):**
- **Prova:** acertos × pontos por questão (definidos na prova, no admin). Máximo = questões sorteadas × pontos por questão (ex.: 5 × 20 = 100). Em resultados antigos que tiveram a nota ajustada pelo admin, vale a ajustada.
- **Prova oral:** lançada no admin (Resultados → "Adicionar Pontos Prova Oral"). Não negativa, até 2 casas decimais, **sem teto**. Sem lançamento = **Pendente** (nunca zero).
- **Total:** soma simples prova + oral, arredondada em 2 casas. Não há peso nem porcentagem. Pode passar da máxima da prova. Enquanto a oral estiver pendente, o total é **Pendente**.
- Números em formato brasileiro (`12,5`). Para números crus use `items[0].writtenScore`, `items[0].oralScore` e `items[0].score`.
- O `displayText` e a ordenação por nota continuam como antes (sem oral, usam a nota da prova).

**Exemplo — oral pendente** (`GET /results?…&pageSize=1`, trechos):
```json
{
  "ok": true,
  "code": "results",
  "data": {
    "total": "1", "pageNumber": "1", "pages": "1", "hasNext": "false",
    "displayText": "Todos os resultados não excluídos.\n\n**1.** <@700000000000000101> · Recruta Silva — **80/100** · Prova TCEL · 25/09/2026 · tentativa `3e31bb` · não promovido\n\nPágina 1/1",
    "items": [{ "attemptId": "6ab609ed158874bbe93e31bb", "score": 80, "writtenScore": 80, "oralScore": "", "hasOral": "false", "…": "…" }],
    "resultSingle": "true",
    "resultAttemptId": "6ab609ed158874bbe93e31bb",
    "resultExamName": "Prova TCEL",
    "resultFinishedAt": "25/09/2026",
    "resultStudentDiscordId": "700000000000000101",
    "resultStudentDisplayName": "Recruta Silva",
    "resultStudentMention": "<@700000000000000101>",
    "resultStudentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png?size=256",
    "resultSupervisorDiscordId": "700000000000000202",
    "resultSupervisorDisplayName": "Cabo Souza",
    "resultSupervisorMention": "<@700000000000000202>",
    "resultSupervisorsText": "⭐ <@700000000000000202> — Cabo Souza (principal, escolhido no Discord)",
    "resultExamScore": "80",
    "resultExamMaxScore": "100",
    "resultOralScore": "Pendente",
    "resultOralPending": "true",
    "resultTotalScore": "Pendente",
    "resultScoreText": "Prova: 80 | Prova oral: Pendente | Total: Pendente"
  }
}
```

**Exemplo — oral lançada (12,5)**, mesma prova depois do lançamento no admin (só o que muda):
```json
{
  "data": {
    "displayText": "Todos os resultados não excluídos.\n\n**1.** <@700000000000000101> · Recruta Silva — Prova (80) + Prova Oral (12,5) = **92,5** · Prova TCEL · 25/09/2026 · tentativa `3e31bb` · não promovido\n\nPágina 1/1",
    "items": [{ "attemptId": "6ab609ed158874bbe93e31bb", "score": 92.5, "writtenScore": 80, "oralScore": 12.5, "hasOral": "true", "…": "…" }],
    "resultExamScore": "80",
    "resultOralScore": "12,5",
    "resultOralPending": "false",
    "resultTotalScore": "92,5",
    "resultScoreText": "Prova: 80 | Prova oral: 12,5 | Total: 92,5"
  }
}
```

**Resultado antigo** (antes desta atualização, sem fiscal do Discord): `resultSupervisorDiscordId = ""`, `resultSupervisorMention = ""`, `resultSupervisorDisplayName = "Sgt Antigo"` (nome registrado), `resultSupervisorsText = "• Sgt Antigo"`. O site **não** atribui um ID por aproximação.

---

## 7. Promoção

O rascunho é **de um operador, num servidor, com prazo** (1 h sem uso). O site confere dono, servidor e prazo em **todo** pedido. Depois de confirmado, o mesmo ID vira o **lote** (`jobId = draftId`).

### `GET /promotion-candidates`
Resultados válidos (finalizados, não excluídos, vinculados ao servidor) de quem ainda não foi promovido pela integração.
- **URL Params:** identificação + `page` + `student` (opcional)
- **Resposta:** `total`, `pages`, `hasNext`… + `opt1…opt25*` (valor = ID da tentativa)

### `POST /promotion-drafts`
Abre (ou continua) o rascunho do operador.
- **Body:** identificação
- **Resposta (`draft_created`/`draft_resumed`):**
  - `draftId`, `selectedCount`, `candidatesTotal`, `page`, `pages`, `hasNext`, `nextPage`, `previousPage`
  - `hasUnfilled`, `nextDiscordUserId`, `nextStudentName`, `nextMention` (quem falta preencher)
  - `readyForReview`, `displayText`
  - **`opt1…opt25*`** (menu dinâmico dos candidatos da página) e a mensagem pronta (modelo "Seleção de promoção")

### `GET /promotion-drafts/{draftId}?page=N`
Mesma resposta, para mostrar outra página ou atualizar.

### `POST /promotion-drafts/{draftId}/selection`
- **Body:** identificação + `page` (a página mostrada) + um dos modos:
  - **Menu dinâmico:** `attemptIds = {selected_options}`. Substitui as marcações **daquela página** e mantém as das outras. O site aceita `a,b,c` ou `["a","b"]`; os valores `vazio-N` são ignorados.
  - **Menu de usuários (alternativa):** `discordUserIds = {selected_options}`. O site valida **todos** antes de aceitar. Quem tiver mais de um resultado precisa ser escolhido pelo menu dinâmico (resultado explícito).
  - `removeDiscordUserIds`: tira pessoas do lote.
- **Erros:** `selection_invalid` (nada muda; a mensagem diz o porquê), `not_eligible` (a lista mudou: atualize), `not_draft_owner`, `draft_expired`.

### `POST /promotion-drafts/{draftId}/members`
Grava NOME RP e ID RP de uma pessoa do lote.
- **Body:** identificação + `member` (ID) + `nomeRP` + `idRP`
- O ID RP é texto: **zeros à esquerda são mantidos** (`007`).
- O apelido `『TCEL•B』NOME | ID` precisa caber em 32 caracteres. Se não couber, `rp_invalid` diz quantos caracteres cortar: o site **nunca** corta sozinho.
- O NOME RP não aceita `@ < > \` " \ { }`.
- **Resposta:** `nickname` + a visão do rascunho (inclui o próximo a preencher)

### `POST /promotion-drafts/{draftId}/review`
O site confere tudo o que depende dele: resultado ainda válido, nota igual à da seleção, ninguém já promovido, RP preenchido, configuração completa.
- **Resposta:** `canConfirm` (`"true"`/`"false"`), `reviewHash`, `blockersText`, mensagem pronta (modelo "Revisão de promoção")
- **Cargos, hierarquia e membro são conferidos pelo BotGhost na execução**, não aqui.

### `POST /promotion-drafts/{draftId}/confirm`
- **Body:** identificação + `reviewHash` (o da revisão) + `idempotencyKey = {interaction_id}`
- **201 `job_created`:** `jobId`, `itemCount`
- **409 `changed_since_review`:** algo mudou. A resposta traz a revisão nova; confirme de novo.
- **409 `already_confirmed`** (com `jobId`): nada é executado duas vezes.
- **409 `nobody_to_promote`:** outro operador promoveu as mesmas pessoas ao mesmo tempo.

### `POST /promotion-drafts/{draftId}/cancel`
Cancela o rascunho. Nenhum membro é alterado.

### `POST /promotion-jobs/{jobId}/claim`
Reserva a execução do lote por 10 minutos (renovada a cada relato). Só uma execução por vez.
- **Body:** identificação
- **Resposta (`job_claimed`):**
  - `leaseToken`, `hasItem`, `memberDiscordId`, `memberMention`, `expectedNickname`, `phase` (`precheck` ou `act`)
  - **slots de cargo:** `addRole1…addRole5` e `removeRole1…removeRole5` (vazio = não fazer; só vêm os que ainda faltam)
  - `needNickname`, contagens (`remainingCount`, `completedCount`, `problemCount`), `jobDone`, `nextAnnouncementId`, `displayText`

### `POST /promotion-jobs/{jobId}/progress`
Relato do BotGhost sobre UMA pessoa. Duas fases:
1. **`precheck`** — estado do membro ANTES de mexer. O site marca como feito o que já está certo; só o resto é pedido.
2. **`result`** — estado DEPOIS. O site só marca "feito" o que o estado relatado confirma.

**Body:** identificação + `leaseToken` + `memberDiscordId` + `phase` + um modo de evidência:

| Modo | Campos |
|---|---|
| **Cargos** (padrão) | `memberStatus = {tcel_mb.status}`, `roleIds = {tcel_mb.response.roles}`, `nickname = {tcel_mb.response.nick}` |
| **Status** (se a lista de cargos vier ilegível) | `evidenceMode = status`, `memberStatus`, e no `result`: `statusReport = add1={tcel_add1.status}, add2={tcel_add2.status}, rem1={tcel_rem1.status}, nick={tcel_nick.status}` |

- `memberStatus = 404` → membro saiu do servidor: a pessoa falha e é liberada.
- Outro status de leitura → `member_read_failed` (nada muda).
- `actionError` (opcional): texto do erro.
- **Resposta:** `itemStatus` da pessoa + as instruções da **próxima** (mesmos campos do `claim`).
- **Erros:**
  - `evidence_unreadable`: a lista de cargos veio como `[object Object]`. Use o modo status.
  - `lease_invalid`: chame `claim` de novo.
  - `wrong_phase`, `item_already_final`.

**Situações da pessoa:**

| Situação | Significado |
|---|---|
| `completed` | Concluída |
| `partial` | Algum passo falhou; retomável |
| `failed` | Nada foi feito |
| `needs_review` | Já tinha os cargos fora da integração, ou a nota mudou depois da confirmação |
| `blocked` | Resultado excluído antes de começar |

### `GET /promotion-jobs/{jobId}` · `POST /promotion-jobs/{jobId}/resume`
- O `GET` mostra a situação do lote.
- O `resume` devolve para a fila **só as etapas que falharam** (e a pessoa passa de novo pela verificação).

**Anúncio:** quando o lote termina, o site cria os avisos de anúncio **só com quem foi concluído**:
- no máximo 40 pessoas por mensagem;
- o cargo só pinga na primeira parte;
- ninguém é anunciado duas vezes.

`nextAnnouncementId` é o aviso a publicar pelo fluxo de avisos (seção 8). Se o fluxo parar, o webhook publica depois de 2 minutos.

---

## 8. Avisos — `POST /notifications/{id}/claim` e `/ack`

São usados pelo **evento de webhook** (variável `{tcel_notification_id}`) e pelo botão de anúncio do Promover. Não precisam de identificação de operador: a chave basta, e a reserva protege.

### `POST /notifications/{id}/claim`
Reserva o aviso por 2 minutos e devolve o conteúdo **atual**.
- **200 `claimed`:**
  - `leaseToken`
  - `action`: `send` (nova mensagem) ou `edit` (editar a existente)
  - `channelId`, `messageId` (quando é `edit`), `keepComponents` (`"true"` no painel)
  - `kind`, `templateKey`, mensagem pronta (`native.*`, `discordBodyJson`)
  - `applyRole` (sempre presente): `"true"` só no 1º envio de um resultado **DAFP** com aprovação automática — então aplique o cargo `roleId` ao membro `memberDiscordId`. Resultados DAFP trazem também os campos da seção D do **BOTGHOST_DAFP_IMPLEMENTACAO.md**.
- **Sem 200 = não publique nada:**

| code | Significado |
|---|---|
| `already_claimed` | Outra execução está cuidando |
| `already_delivered` | Já foi entregue |
| `ambiguous_needs_review` | O admin precisa conferir o canal |
| `cancelled` | Resultado excluído antes de publicar |
| `failed` / `not_found` | Falhou ou não existe |

### `POST /notifications/{id}/ack`
Confirma com o **ID real** da mensagem. Sem isso o aviso não conta como entregue: a resposta 200 do webhook não é prova de entrega.
- **Body:**
  - `leaseToken`
  - `outcome` (`delivered` ou `failed`)
  - `messageId` (ID da mensagem enviada; no `edit`, o próprio `messageId` do claim)
  - `channelId`
  - `error` (texto, quando `failed`)
- **200 `acked`** / **`already_acked`** (repetir é seguro) / **`will_retry`** / **409 `lease_mismatch`** (a reserva venceu)

**Regras de segurança dos avisos:**
- Se a reserva de um **envio** vencer sem `ack`, o aviso vira **ambíguo** e **nunca** é reenviado sozinho. O admin confere o canal e decide.
- Um `ack` atrasado com o mesmo `leaseToken` resolve a ambiguidade.
- Mudança de nota enquanto reservado agenda nova edição depois.
- Um resultado excluído **edita** a mensagem para "removido". Excluir ou editar nota **não desfaz** promoção.
