# BOTGHOST — Implementação DAFP (estado atual) e preservação do TCEL

Referência técnica **completa e atual** para configurar **manualmente** no BotGhost o comando `/provas-dafp` e o ciclo de cargos das provas DAFP, sem mexer no `/provas-tcel` que já funciona. Foi escrita para ser entregue a outra IA, que vai transformá-la num tutorial campo por campo.

> **Como ler os exemplos**
> - As respostas JSON foram geradas pelo próprio site, em teste automatizado. Os IDs do Discord, os IDs de prova/sessão/aviso e os links são **fictícios**.
> - `message` (quando é embed), `native`, `discordBodyJson` e `discordCallbackJson` (mensagem pronta) aparecem abreviados como `"(...)"`.
> - Nenhuma variável do BotGhost é inventada aqui. Onde aparece `<valor>`, o valor vem da interação ou de uma resposta anterior. O nome da variável que carrega esse valor no BotGhost é você quem escolhe no seu bloco.
> - IDs fictícios de cargos usados nos exemplos:
>   - `810000000000000001` = **Bombeiros Militares da Fluxo** (Role base);
>   - `810000000000000002` = **Mérito em Proficiência**;
>   - `810000000000000003` = **Aprovado Prova Aspirante**;
>   - `810000000000000004` = **Aprovado Prova Capitão** (seção K).
> - A Role `1261488723615420517` (quem pode usar **VERIFICAR NOTA**, seção K) é **real**, informada pelo dono do servidor.

---

## 0. Regras comuns a TODOS os pedidos (TCEL e DAFP)

| Item | Valor |
|---|---|
| **Endereço base** | `https://SEU-SITE.onrender.com/api/integrations/botghost` (o endereço exato aparece na aba **Integração BotGhost** do painel) |
| **Cabeçalho obrigatório** | `Authorization: Bearer <chave do site>` (a chave fica em **Manage Secrets** do BotGhost; é a mesma `BOTGHOST_SITE_API_KEY` do Render) |
| **Content-Type** (POST) | `application/json` |
| **Formato de toda resposta** | `{ "ok": true/false, "code": "...", "message": "...", "data": { ... } }` |
| **Campos em `data`** | sempre texto ou número simples, exceto as listas `exams`, `items` e `roleActions`; `"true"`/`"false"` são **texto** |
| **`data.displayText`** | sempre presente (texto pronto para mostrar) |
| **IDs do Discord** | sempre **texto entre aspas**. O site recusa ID como número (400), porque número perde dígitos |

**Identificação de quem clicou.** Vai no **Request Body** dos POST e nos **URL Params** dos GET. **Não** vai nos pedidos `/notifications/...`, que só usam a chave.

| Campo | Conteúdo |
|---|---|
| `guildId` | ID do servidor onde o comando foi usado |
| `actorDiscordId` | ID de quem executou o comando (o professor) |
| `channelId` | ID do canal onde o comando foi usado |
| `actorDisplayName` | nome exibido de quem executou |
| **`actorRoleIds`** | **só nas rotas `/dafp/*`, obrigatório:** os **cargos de quem executou** o comando (IDs ou menções `<@&ID>`). É por ele que o site confere a **Role de Professor DAFP** (seção 0.1). As rotas TCEL ignoram este campo |

### 0.1 Quem pode usar o `/provas-dafp`: Role de Professor DAFP
- **Configuração no site:** aba **Integração BotGhost → Provas DAFP → "Role de Professor DAFP (ID do cargo)"**. É o ID de **um cargo** do Discord, **não** uma lista de usuários. Aceita o ID ou a menção `<@&ID>`.
- **Regra:** o pedido é aceito quando os cargos de quem executou (`actorRoleIds`) **incluem** essa Role.
  - `actorDiscordId` continua sendo **o ID de quem executou** (vai para o registro e a chave de repetição). Ele **nunca** é comparado com o ID da Role.
  - **Qual** Role é exigida é decidido **só no site**. O pedido informa apenas os cargos que a pessoa tem; ele não escolhe a Role a conferir.
- **O que o BotGhost envia em `actorRoleIds`:** a variável do BotGhost com os **cargos de quem executou o comando/clicou**, escolhida no seletor de variáveis do bloco. Nenhum nome de variável é inventado aqui: use a que o seu editor oferece para os cargos do usuário da interação.
  - Ela precisa trazer os **IDs** ou as **menções** (`<@&ID>`) dos cargos, **não** os nomes.
  - Formatos aceitos: `"820000000000000001"`, `"820000000000000002,820000000000000001"`, `"<@&820000000000000002> <@&820000000000000001>"`, ou uma lista de textos `["820000000000000002","820000000000000001"]`.
  - Separadores livres (vírgula, espaço, quebra de linha). IDs **como número** no JSON são recusados (`400`), como em todos os IDs.
  - **Em GET** vai nos **URL Params**; **em POST**, no **Request Body**, junto com a identificação.
- **Por que o site confia nesses cargos:**
  - o site **não** fala com o Discord (não tem token de bot, por decisão do projeto);
  - quem atesta os cargos é o **próprio BotGhost**, autenticado pela chave secreta (`Authorization: Bearer`), a mesma confiança já dada ao `actorDiscordId`;
  - validar a Role direto no Discord exigiria o **token do bot no site**, o que este projeto **não** faz.
  - **Recomendado no BotGhost:** colocar também uma **condição de cargo** (Role de Professor DAFP) antes de chamar o site, para quem não tem a Role receber a resposta na hora.
- **Como testar a variável:** chame `GET /dafp/exams` no Request Builder com a identificação + `actorRoleIds`.
  - Se voltar `403 operator_not_allowed`, olhe `data.rolesReceived`: é **quantos cargos o site conseguiu ler**.
  - `"0"` = a variável veio vazia ou com **nomes** em vez de IDs/menções.

Respostas reais:
- **Sem a Role** (`403`, com a mensagem pronta "⛔ …" em `data.message` / `data.native` / `data.discordCallbackJson`, como toda negação):
  ```json
  {"ok": false, "code": "operator_not_allowed", "message": "Você não está autorizado a gerar provas DAFP: é preciso ter a Role de Professor DAFP.", "data": {"rolesReceived": "1", "message": "(...)", "native": "(...)", "discordBodyJson": "(...)", "discordCallbackJson": "(...)", "displayText": "Você não está autorizado a gerar provas DAFP: é preciso ter a Role de Professor DAFP."}}
  ```
- **`actorRoleIds` não enviado** (`400`):
  ```json
  {"ok": false, "code": "invalid_field", "message": "actorRoleIds obrigatório no /provas-dafp: envie os cargos de quem executou o comando (IDs ou menções).", "data": {"field": "actorRoleIds", "displayText": "actorRoleIds obrigatório no /provas-dafp: envie os cargos de quem executou o comando (IDs ou menções)."}}
  ```
- **Role de Professor DAFP não configurada no site** (`403`): `code = "operators_not_configured"`, `message = "A Role de Professor DAFP não foi configurada no site (aba Integração BotGhost → Provas DAFP)."`.

**Chave de repetição (`idempotencyKey`).**
- Obrigatória nos POST que criam algo (criar sessão, regenerar links).
- Use o ID da interação: é o mesmo durante todo aquele clique/formulário.
- O **mesmo pedido repetido** devolve a mesma resposta, **sem criar outra sessão** e **sem mostrar os links de novo**.
- A **mesma chave com conteúdo diferente** devolve `409 idempotency_conflict`.

---

## A. Fluxo TCEL existente (`/provas-tcel`) — NÃO muda

**Nenhuma alteração é necessária no `/provas-tcel` do BotGhost.** Rotas, parâmetros, respostas e mensagens continuam iguais.

**Nada do ciclo de cargos DAFP vale para o TCEL** (testado):
- iniciar uma prova TCEL não gera aviso de início;
- o resultado TCEL não traz ações de cargo;
- a mensagem TCEL é a mesma de antes.

### Identificação fixa da TCEL
- A prova do fluxo TCEL é **sempre** a prova de **slug `tcel`** (identificador interno fixo), do grupo **TCEL**.
- O `examId` enviado pelo fluxo TCEL é **ignorado**. Mesmo mandando o ID de uma prova DAFP, a sala é criada na prova `tcel` (testado).
- Se a prova `tcel` estiver desativada ou sem questões ativas, o fluxo TCEL responde `409 exam_not_eligible` e **não** abre outra prova.
- Provas DAFP nunca aparecem em `GET /exams` (lista TCEL), em `GET /results` (Conferir resultados TCEL) nem nos candidatos da promoção TCEL.
- **Migração automática** (ao iniciar o site): a prova TCEL existente recebe `slug = "tcel"` e `group = "TCEL"`.
  - **Como ela é identificada:**
    1. a "prova padrão" da aba Integração;
    2. senão, a prova da sala mais recente criada pelo Discord;
    3. senão, a única prova existente.
  - Se não der para identificar com segurança, nada é marcado e o painel mostra um aviso para marcar a prova (identificador `tcel`).
- A prova `tcel` não pode trocar de identificador nem de grupo pelo painel.

### Rotas TCEL (sem mudança de contrato)

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/health` | teste da chave (sem identificação) |
| `GET` | `/exams` | prova do fluxo TCEL: sempre só a `tcel`, com `choiceRequired = "false"` |
| `POST` | `/rooms/prepare` | valida aluno/fiscal e avisa sala aberta |
| `POST` | `/rooms` | **cria a sala TCEL** |
| `POST` | `/rooms/{roomId}/regenerate-links` | novos links |
| `GET` | `/results` | Conferir resultados (só TCEL) |
| `GET`/`POST` | `/promotion-*` | promoção (só resultados TCEL) |

**`POST /rooms`** — Request Body (como já configurado):
```json
{
  "guildId": "900000000000000000",
  "actorDiscordId": "700000000000000009",
  "channelId": "600000000000000001",
  "actorDisplayName": "Operador",
  "student": "700000000000000303",
  "studentDisplayName": "Recruta TCEL",
  "supervisorDiscordId": "(opcional, fiscal)",
  "supervisorDisplayName": "(opcional)",
  "studentAvatarUrl": "(opcional)",
  "examId": "(opcional — IGNORADO: sempre a TCEL)",
  "idempotencyKey": "1234567890123456789"
}
```
Resposta `201 room_created`: igual à de antes (`roomId`, `roomLabel`, `roomCode`, `examId`, `examName`, `studentDiscordId`, `supervisor*`, `studentUrl`, `supervisorUrl`, `linksAvailable` e a mensagem privada pronta). **Não** traz campos DAFP.

**Único acréscimo no TCEL:** na reserva (`claim`) de avisos TCEL passaram a vir também campos extras, que o fluxo TCEL pode ignorar:
- `notificationActionType = "TCEL_RESULT"` (ou `PROMOTION_ANNOUNCEMENT`, `TEMPLATE_TEST`, `PANEL_UPDATE`);
- `publishMessage = "true"`;
- `roleAction1..3Enabled = "false"`.

Nada foi removido ou renomeado.

---

## B. Listagem das provas DAFP

**`GET /dafp/exams`**
- **Autenticação:** `Authorization: Bearer <chave>` + identificação em **URL Params**.
- **Quem pode usar:** quem tem a **Role de Professor DAFP** (seção 0.1), conferida em `actorRoleIds`. Isso é **separado** das listas de operadores TCEL.
- **Canal:** se "Canal do /provas-dafp" estiver preenchido na aba Integração, só esse canal é aceito.
- **O que retorna:** só provas do grupo **DAFP**, **ativas** e com **questões ativas**. A TCEL nunca aparece.

Request (URL Params):
```
GET /dafp/exams?guildId=900000000000000000&actorDiscordId=700000000000000009&channelId=600000000000000001&actorDisplayName=Professor&actorRoleIds=<@&820000000000000002> <@&820000000000000001>
```

Resposta real `200 dafp_exams` (com uma prova cadastrada; as opções `opt2…opt25` vêm com `Hide = "true"` e foram omitidas):
```json
{
  "ok": true,
  "code": "dafp_exams",
  "message": "1 prova(s) DAFP apta(s).",
  "data": {
    "examCount": "1",
    "exams": [
      {
        "examId": "6ab7844fc58518746e9be9c5",
        "examSlug": "aspirante",
        "examName": "Aspirante",
        "examGroup": "DAFP",
        "questionCount": "10",
        "pointsPerQuestion": "1",
        "examMaxScore": "10",
        "durationMinutes": "120",
        "autoApproval": "true",
        "passingScore": "7",
        "approvedRoleId": "810000000000000003",
        "failedRoleId": "",
        "resultChannelId": "600000000000000009",
        "dafpBaseRoleId": "810000000000000001",
        "dafpPerfectScoreRoleId": "810000000000000002"
      }
    ],
    "displayText": "1. Aspirante (aspirante)",
    "opt1Label": "Aspirante",
    "opt1Description": "10 questões · 120 min · mínimo 7",
    "opt1Value": "aspirante",
    "opt1Hide": "false",
    "opt1Default": "false"
  }
}
```
`failedRoleId` é **legado**: vem sempre vazio, porque reprovado não recebe mais cargo.

### Menu de seleção (Select Menu)
O BotGhost não monta um menu a partir de uma lista (array). Por isso o site devolve **25 opções fixas prontas**, cada uma com cinco campos:
- `optNLabel`: texto da opção;
- `optNDescription`: descrição;
- `optNValue`: o **slug** da prova, que é o valor a enviar depois;
- `optNHide`: `"true"` quando a posição está vazia;
- `optNDefault`: `"false"`.

**Alternativas:**
- **Menu com valores fixos:** os slugs digitados à mão (`aspirante`, `segundo-tenente`, `primeiro-tenente`, `capitao`, `major` — os que você definir no painel).
- **Validar uma prova individualmente:** `GET /dafp/exams/{ref}` (abaixo).

### Consulta/validação de UMA prova DAFP
**`GET /dafp/exams/{ref}`**, em que `{ref}` é o slug ou o `examId`. Mesma autenticação e identificação.
- **Resposta `200 dafp_exam`:** os mesmos campos de cada item de `exams`, mais:
  - `active` (`"true"`/`"false"`);
  - `eligible` (`"true"` = pode ser iniciada);
  - `displayText`.
- **Erros:**
  - TCEL ou outra prova fora do grupo DAFP → `409 exam_not_dafp`;
  - inexistente → `404 exam_not_found`.

---

## C. Criação da sessão DAFP

**`POST /dafp/rooms`**
- **Headers:** `Authorization: Bearer <chave>` e `Content-Type: application/json`.
- **Permissão:** a **Role de Professor DAFP** em `actorRoleIds` (seção 0.1).
- **Sessão = sala:** `sessionId` é igual a `roomId`.
- **Cargos:** criar a sessão **não altera cargo nenhum**. A Role base só sai quando o aluno **inicia** a prova (seção E).

### Request Body COMPLETO
| Campo | Obrigatório | Conteúdo |
|---|---|---|
| `guildId` | sim | ID do servidor |
| `actorDiscordId` | sim | ID do professor que executou o `/provas-dafp` |
| `channelId` | sim* | ID do canal (*obrigatório se o canal do /provas-dafp estiver configurado) |
| `actorDisplayName` | não | nome do professor |
| **`actorRoleIds`** | **sim** | cargos de quem executou (IDs ou menções `<@&ID>`); precisa incluir a Role de Professor DAFP (seção 0.1) |
| `student` | **sim** | ID do **aluno**, ou a menção `<@ID>` |
| `supervisorDiscordId` | **sim** | ID do **avaliador**, ou a menção `<@ID>`. Precisa ser outra pessoa que não o aluno |
| `examSlug` | **sim** | slug da prova escolhida (ex.: `aspirante`). Aceita também `examId` no lugar |
| `studentDisplayName` | não | nome do aluno na prova. Vazio → `Aluno 1234` (final do ID) |
| `supervisorDisplayName` | não | nome do avaliador. Vazio → `Fiscal 1234` |
| `studentAvatarUrl` | não | foto do aluno: só URL HTTPS do CDN do Discord com o ID do aluno. Qualquer outra coisa é ignorada, sem erro |
| `idempotencyKey` | **sim** | ID da interação (6–100 caracteres: letras, números, `: _ . -`) |

**O que o site valida** (o nome da prova enviado nunca é usado):
1. a prova existe (pelo slug ou ID);
2. está ativa;
3. é do grupo **DAFP**;
4. tem questões ativas;
5. o avaliador foi informado e não é o aluno;
6. não há outra sessão aberta do mesmo aluno na mesma prova.

Exemplo de request:
```json
{
  "guildId": "900000000000000000",
  "actorDiscordId": "700000000000000009",
  "channelId": "600000000000000001",
  "actorDisplayName": "Professor",
  "actorRoleIds": "<@&820000000000000002> <@&820000000000000001>",
  "student": "700000000000000101",
  "studentDisplayName": "Recruta Lima",
  "supervisorDiscordId": "700000000000000202",
  "supervisorDisplayName": "Cap Souza",
  "examSlug": "aspirante",
  "idempotencyKey": "1300000000000000001"
}
```

Resposta real COMPLETA `201 room_created`. `message`, `native`, `discordBodyJson` e `discordCallbackJson` trazem a mensagem privada pronta do modelo "Sala criada".
```json
{
  "ok": true,
  "code": "room_created",
  "message": "Sala criada. Os links vão só nesta resposta privada.",
  "data": {
    "roomId": "6ab7844fc58518746e9be9e6",
    "roomLabel": "Discord FFE3CB",
    "roomCode": "#9be9e6",
    "examId": "6ab7844fc58518746e9be9c5",
    "examName": "Aspirante",
    "studentDiscordId": "700000000000000101",
    "studentAvatarSaved": "false",
    "supervisorDiscordId": "700000000000000202",
    "supervisorDisplayName": "Cap Souza",
    "supervisorMention": "<@700000000000000202>",
    "supervisorSelected": "true",
    "sessionId": "6ab7844fc58518746e9be9e6",
    "sessionStatus": "CRIADA",
    "examGroup": "DAFP",
    "examSlug": "aspirante",
    "studentMention": "<@700000000000000101>",
    "studentAvatarUrl": "",
    "examMaxScore": "10",
    "autoApproval": "true",
    "passingScore": "7",
    "approvedRoleId": "810000000000000003",
    "failedRoleId": "",
    "resultChannelId": "600000000000000009",
    "dafpBaseRoleId": "810000000000000001",
    "dafpPerfectScoreRoleId": "810000000000000002",
    "studentUrl": "https://provas.example.com/aluno/G7E7o6getpahHiTBqItEt8r6vmAPc2wtVYOBnNAdMZ0",
    "supervisorUrl": "https://provas.example.com/professor/_hAtZRv6EuB4ZJbKYU5fifwajlAC1Qx-IcqX_wT0QMY",
    "linksAvailable": "true",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)", "discordCallbackJson": "(...)",
    "displayText": "Sala criada. Os links vão só nesta resposta privada."
  }
}
```
- **Links:**
  - `studentUrl` é o link do **aluno**; `supervisorUrl` é o link do **avaliador** (o escolhido, não quem clicou);
  - **só aparecem nesta resposta**;
  - mande cada link só para a pessoa certa, em privado.
- **Repetição** (mesma `idempotencyKey`): `200 room_already_created`, com `linksAvailable = "false"` e sem links.
- **Sessão já aberta** para o mesmo aluno e prova: `409 room_exists` (`roomId`, `canRegenerate = "true"`).

**Outras rotas da sessão:**
- **`POST /dafp/rooms/prepare`:** mesmo body, sem `idempotencyKey`. Não cria nada; responde `200 ready` ou os mesmos erros da criação.
- **`POST /dafp/rooms/{sessionId}/regenerate-links`:** body = identificação + `idempotencyKey`. Gera novos links; os antigos param de funcionar. O avaliador continua o mesmo.

---

## D. Campos da sessão / resultado DAFP

A consulta da sessão, a lista de resultados e a reserva (`claim`) de avisos DAFP **usam os mesmos nomes**.

| O quê | Campo |
|---|---|
| ID da sessão | `sessionId` (= `roomId`) |
| ID da tentativa | `attemptId` (vazio antes de o aluno começar) |
| Status da sessão | `sessionStatus`: `CRIADA` \| `EM_ANDAMENTO` \| `FINALIZADA` \| `ENCERRADA` |
| Aluno | `studentDiscordId`, `studentMention` (`<@ID>`), `studentDisplayName`, `studentAvatarUrl` |
| Avaliador | `supervisorDiscordId`, `supervisorMention` (`<@ID>`), `supervisorDisplayName` |
| Prova | `examId`, `examSlug`, `examName`, `examGroup` (`DAFP`) |
| Links | `studentUrl`, `supervisorUrl` (**só** na criação/regeneração) |
| Nota | `score`, `maxScore`, `scoreText` (ex.: `8/10`) |
| Aprovação automática | `autoApproval` (`"true"`/`"false"`), `passingScore` |
| Resultado | `resultStatus`: `APROVADO` \| `REPROVADO` \| `NAO_APLICAVEL`; `passed` (`"true"`/`"false"`; vazio sem aprovação automática) |
| **Gabarito** | **`perfectScore`**: `"true"` \| `"false"` (vazio antes de finalizar) |
| Como terminou | `finishReason`: `FINALIZADA_PELO_ALUNO` \| `TEMPO_ESGOTADO` \| `ENCERRADA_PELO_ADMIN` |
| Cargo de aprovado desta prova | `approvedRoleId`; `resultRoleId` = o cargo de aprovado **só se aprovado** (vazio caso contrário) |
| Cargos globais DAFP (configuração atual) | **`dafpBaseRoleId`** (Role base) e **`dafpPerfectScoreRoleId`** (Mérito em Proficiência) |
| **Situação da Role base nesta tentativa** | **`dafpBaseRoleState`**: vazio (Role base não foi retirada) \| `SUSPENSA` (prova em andamento) \| `DEVOLUCAO_PENDENTE` (a prova saiu de "em andamento" e o BotGhost ainda não confirmou a devolução) \| `DEVOLVIDA` (devolução confirmada) — seção E.1 |
| Canal do resultado | `resultChannelId` (o da prova; se vazio, o **canal padrão DAFP**) |
| Finalizada em | `finishedAt` (ISO 8601, UTC) e `finishedAtText` (horário de Brasília) |
| Resultado já publicado pelo webhook? | `resultPublished` (`"true"`/`"false"`) |
| **Ações de cargo** | `roleActionsPhase` (`START` \| `FINISH` \| vazio), `roleActions` (lista) e os campos fixos `roleAction{1,2,3}Enabled`, `roleAction{1,2,3}Type`, `roleAction{1,2,3}RoleId`, `roleAction{1,2,3}MemberDiscordId` (seção E) |
| **LEGADO** | `failedRoleId` (sempre vazio em resultados novos); `applyRole` / `roleId` / `memberDiscordId` (só no `claim`, ver seção I) |

### Regras da nota, aprovação e gabarito (calculadas SÓ no servidor)
- **Nota** = acertos × pontos por questão. A **nota máxima** = questões sorteadas × pontos por questão.
- **Aprovação automática = Sim:** `APROVADO` se `nota >= notaMinima`; senão `REPROVADO`. Nota **igual** à mínima **aprova**. Não há porcentagem.
- **Aprovação automática = Não:** `resultStatus = "NAO_APLICAVEL"`.
- **Gabarito:** `perfectScore = "true"` quando `nota == nota máxima`, comparado com 2 casas decimais, a mesma precisão das notas do sistema. É **independente** da aprovação automática. O navegador e o BotGhost nunca informam isso.
- **Cancelamento:** prova DAFP encerrada pelo admin (`finishReason = ENCERRADA_PELO_ADMIN`) conta como **cancelamento**: `resultStatus = NAO_APLICAVEL` e `perfectScore = "false"`. Só a Role base volta.
- **Congelado na finalização:** tudo é decidido **uma vez**, na finalização, e gravado no resultado. Mudar a configuração da prova ou dos cargos depois **não** reescreve resultados antigos.

---

## E. Ciclo de cargos do DAFP

### Os três cargos
| Cargo | Onde se configura | Quando |
|---|---|---|
| **Role base** (ex.: Bombeiros Militares da Fluxo) | aba **Integração BotGhost → Provas DAFP → Cargos automáticos DAFP → "Role obrigatória durante o fluxo"** (global) | **REMOVIDA** quando o aluno **inicia** a prova; **ADICIONADA de volta** sempre que a prova **deixa de estar em andamento**, por **qualquer** motivo (aprovado, reprovado, tempo esgotado/abandono, encerrado pelo admin, resultado excluído/cancelado). Regras completas na seção E.1 |
| **Cargo de aprovado da prova** (ex.: Aprovado Prova Aspirante) | cada prova → **⚙ Integração / Resultado → "ID do cargo de APROVADO"** | **ADICIONADO** só se `resultStatus = APROVADO` |
| **Mérito em Proficiência** | aba **Integração BotGhost → Provas DAFP → Cargos automáticos DAFP → "Mérito em Proficiência"** (global) | **ADICIONADO** só se `perfectScore = "true"` |

- **Reprovado não recebe cargo.** O antigo "cargo de reprovado" é legado: não aparece mais no painel e não é usado.
- **Nenhum ID de cargo está fixo no código:** todos são configurados no painel.

### Momentos
1. **Sessão criada** (`CRIADA`): **nenhuma** ação de cargo.
2. **Aluno inicia a prova de verdade** (`CRIADA → EM_ANDAMENTO`): é quando ele confirma o compartilhamento de tela e a tentativa é criada.
   - O site cria **UM** aviso `dafp_started` → **REMOVE** a Role base.
   - Recarregar a página, reconectar ou clicar de novo **não** cria outro (a chave do aviso é única por tentativa).
   - Abrir o link sem começar a prova não remove nada.
3. **A prova deixa de estar em andamento** (finalizada, tempo esgotado, encerrada pelo admin, resultado excluído):
   - o site cria **UM** aviso próprio `dafp_base_restore` → **ADD** da Role base, **sem mensagem**. Ele não depende da mensagem de resultado, do canal, do modelo nem de existir resultado acadêmico;
   - se houver resultado a publicar, o aviso de resultado (`result`) traz a mensagem e as ações de fim (ADD base, aprovado, Mérito). O ADD da Role base aparece nos dois: repetir é seguro, e o que chegar primeiro resolve (o outro vira redundante ou é cancelado).

### Posições FIXAS das ações
| Posição | Início (`DAFP_STARTED`) | Fim (`DAFP_FINISHED`) |
|---|---|---|
| **1** | `REMOVE` Role base | `ADD` Role base (**sempre**) |
| **2** | — | `ADD` cargo de aprovado da prova (só `APROVADO`) |
| **3** | — | `ADD` Mérito em Proficiência (só `perfectScore = "true"`) |

- Posição sem ação → `roleActionNEnabled = "false"` e os demais campos vazios.
- `roleActionNMemberDiscordId` = sempre o ID do **aluno**.

### Cenários (Aspirante, máximo 10, mínimo 7)
| Situação | `resultStatus` | `perfectScore` | Ação 1 | Ação 2 | Ação 3 |
|---|---|---|---|---|---|
| Criou a sala | — | — | — | — | — |
| Iniciou a prova | — | — | REMOVE base | — | — |
| 6/10 | REPROVADO | false | ADD base | — | — |
| 7/10 | APROVADO | false | ADD base | ADD aprovado | — |
| 8/10 | APROVADO | false | ADD base | ADD aprovado | — |
| 10/10 | APROVADO | true | ADD base | ADD aprovado | ADD Mérito |
| Sem aprovação automática, 10/10 | NAO_APLICAVEL | true | ADD base | — | ADD Mérito |
| Sem aprovação automática, 5/10 | NAO_APLICAVEL | false | ADD base | — | — |
| Iniciou e o admin encerrou a sala | NAO_APLICAVEL | false | ADD base | — | — |
| Iniciou e abandonou (fechou a aba e não voltou) → o prazo da prova acabou | conforme a nota do que respondeu | conforme a nota | ADD base | conforme `resultStatus` | conforme `perfectScore` |
| Iniciou e o resultado foi excluído/invalidado (cancelada) | — | — | ADD base (só no aviso `dafp_base_restore`, sem mensagem) | — | — |

Em **todas** as linhas a partir de "6/10", além do aviso de resultado, existe o aviso próprio `dafp_base_restore` com **só** a posição 1 = `ADD` Role base.

Se um cargo não estiver configurado no painel, a posição correspondente vem desligada (`"false"`).

### Garantias
- **Uma ação por fase:**
  - um único aviso de início por tentativa;
  - um único aviso de resultado por tentativa;
  - as ações de fim vêm **só até a primeira entrega confirmada**. Edições posteriores (ex.: prova oral lançada no admin, resultado excluído depois de publicado) editam a mensagem com as posições 1–3 desligadas.
- **Finalização duplicada** (clique duplo, recarregar, tempo esgotado ao mesmo tempo, admin encerrando) gera **um** resultado e **um** aviso (testado com chamadas simultâneas).
- **Ordem:** a devolução nunca passa na frente da remoção (e vice-versa).
  - Se a prova terminar antes de o BotGhost executar a remoção do início, a remoção é **cancelada** (a devolução já deixa o aluno com a Role).
  - Se uma remoção do mesmo aluno estiver com o BotGhost naquele instante, o `claim` da devolução (ou do resultado com ADD base) responde `409 not_ready` e o site tenta de novo sozinho em seguida.
  - Se uma devolução do mesmo aluno estiver com o BotGhost e ele iniciar outra prova, o `claim` da nova remoção responde `409 not_ready` até a devolução ser confirmada.
- **Falha no Discord/BotGhost não desfaz a prova.**
  - A tentativa continua iniciada, e a nota e a aprovação continuam gravadas.
  - O aviso segue a política da fila: nova tentativa com espera; depois de esgotar, fica "com falha" e reprocessável pela aba Integração → **Reprocessar agora**.
  - O erro fica registrado (`lastError`) para diagnóstico.
- **Estado desejado, não erro:** adicionar um cargo que o aluno já tem ou remover um que ele não tem deixa o mesmo estado final. Por isso o site pode repetir uma ação de cargo com segurança (ex.: reserva vencida sem confirmação).
- **Rede de segurança:** a reconciliação periódica recria o aviso de remoção que faltou e **garante** a devolução de toda prova que saiu de "em andamento" sem devolução confirmada (seção E.1).

### E.1 Proteção da Role base (estado desejado)

**Regra fundamental:** se o aluno **não** está realizando **agora** uma prova DAFP efetivamente em andamento, ele precisa **ter** a Role base (Bombeiros Militares da Fluxo). O site decide **quando** agir; o BotGhost só executa a ordem.

| Situação da prova DAFP do aluno | Estado desejado da Role base |
|---|---|
| Existe uma prova DAFP **efetivamente em andamento** | **AUSENTE** |
| Não existe nenhuma | **PRESENTE** |

"Efetivamente em andamento" = a tentativa está `EM_ANDAMENTO` **e** não foi excluída/invalidada pelo admin.

#### Quando o site considera que a prova COMEÇOU (gera o REMOVE)
- Quando o aluno, na tela do link, conclui o compartilhamento de tela e clica para **começar a prova**: nesse instante o site cria a tentativa (`CRIADA → EM_ANDAMENTO`) e **um** aviso `dafp_started` com `roleAction1Type = "REMOVE"`.
- **Não** gera REMOVE: criar a sala, abrir o link, ver a tela de boas-vindas, compartilhar a tela sem começar, recarregar a página, reconectar, perder a conexão e voltar.
- Só é gerado se a **Role obrigatória durante o fluxo** estiver configurada no painel e a sessão tiver o aluno do Discord.

#### Quando o site considera que a prova TERMINOU (gera o ADD)
A devolução depende do **estado operacional** da tentativa, nunca do botão "Finalizar" nem do resultado acadêmico. Toda saída de "em andamento" gera o ADD:

| O que aconteceu | Como o site detecta | Estado da tentativa | Resultado acadêmico (`resultStatus`) | ADD Role base |
|---|---|---|---|---|
| Aluno clicou em Finalizar | pedido do aluno | `FINALIZADA`, `finishReason = FINALIZADA_PELO_ALUNO` | pela nota | **sim** |
| Tempo da prova acabou | o servidor confere o prazo de cada prova a cada 15 s (inclusive logo depois de o site reiniciar) e também quando o aluno volta à página | `FINALIZADA`, `finishReason = TEMPO_ESGOTADO` | pela nota do que foi respondido | **sim** |
| **Abandono** (fechou a aba, caiu a internet e não voltou) | é o mesmo caso acima: a prova fica em andamento até o **prazo da própria prova** e então é encerrada pelo servidor | `FINALIZADA`, `finishReason = TEMPO_ESGOTADO` | pela nota do que foi respondido | **sim** |
| Admin encerrou a sala durante a prova (painel → Encerrar sala) | ação do admin | `FINALIZADA`, `finishReason = ENCERRADA_PELO_ADMIN` | `NAO_APLICAVEL` (**cancelamento**: sem aprovado, sem reprovado, sem Mérito) | **sim** |
| Admin excluiu/invalidou o resultado com a prova em andamento (cancelada) | ação do admin (Resultados → Excluir nota) | excluída; a sala volta a aceitar uma nova tentativa | nenhum | **sim** (sem mensagem) |

**Abandono não é reprovação automática.**
- Desconexão, refresh, queda de internet, perda do WebSocket/WebRTC ou fechar a página **não** encerram a prova: o aluno pode voltar e continuar do ponto em que estava, com o mesmo cronômetro.
- **Não existe** um "tempo de desconexão" que encerre a prova. O único encerramento automático é o **prazo da própria prova** (duração configurada), que já existia antes desta atualização.
- Nesse encerramento a prova é corrigida com o que foi respondido. Essa é a regra acadêmica que já existia para "tempo esgotado": o resultado sai APROVADO, REPROVADO ou NAO_APLICAVEL **pela nota**, nunca "reprovado por abandono".

#### Estado persistido na tentativa (para recuperação)
Cada tentativa DAFP guarda (no banco, campo `dafpBaseRole`):

| Campo | Quando é preenchido |
|---|---|
| `suspendedAt` | a tentativa entrou em andamento com a Role base configurada |
| `removeRequestedAt` | o aviso de remoção (`dafp_started`) foi criado |
| `removeConfirmedAt` | o BotGhost confirmou a remoção (`ack` do `dafp_started`) |
| `releasedAt` | a tentativa saiu de "em andamento" (qualquer motivo) |
| `restoreRequestedAt` | o aviso de devolução (`dafp_base_restore`) foi criado |
| `restoreConfirmedAt` | o BotGhost confirmou um ADD da Role base desta tentativa |
| `restoreConfirmedVia` | qual aviso confirmou: `dafp_base_restore`, `result` ou `superseded` (a Role do aluno foi confirmada como devolvida por uma prova **posterior** dele, sem nenhuma prova em andamento) |

Além disso, `dafpBaseRoleRemovedId` guarda **qual** Role foi retirada: é exatamente essa que volta, mesmo que a configuração mude no meio.

O BotGhost vê o resumo em **`dafpBaseRoleState`** (seção D): `SUSPENSA` → `DEVOLUCAO_PENDENTE` → `DEVOLVIDA`.

#### Recuperação em caso de falha
A prova **nunca** depende do Discord: iniciar, finalizar, cancelar e corrigir acontecem no site mesmo com o BotGhost fora do ar. As ações de cargo ficam na fila até serem confirmadas.

| Falha | O que acontece |
|---|---|
| Webhook do BotGhost fora do ar / erro de rede / 429 / 5xx | o aviso volta para a fila com espera crescente; o erro fica em `lastError` |
| BotGhost reservou e não confirmou em 2 minutos (travou, timeout, ramo do evento sem `ack`) | aviso só de cargos **volta para a fila** com espera crescente. Cada reserva sem `ack` **conta como tentativa**: depois de **6**, fica **"com falha"** (`lastError` explica), sem disparar mais sozinho |
| BotGhost respondeu `outcome: "failed"` (ex.: bot sem permissão, Discord indisponível) | nova tentativa com espera; depois de 6 falhas fica "com falha" |
| Aviso de devolução cancelado, e a devolução **não** confirmada | a **reconciliação** (ao ligar o site e a cada 5 minutos) o **recoloca na fila sozinha**, sem depender do admin, **desde que** a tentativa dele esteja encerrada e o aluno não esteja em outra prova DAFP |
| Aviso de devolução **"com falha"** e a devolução **não** confirmada | a reconciliação o recoloca na fila **30 minutos** depois da última falha (não fica disparando sem parar). O admin pode usar "Reprocessar agora" antes disso |
| Site reiniciou (Render) entre o fim da prova e a criação do aviso, ou o aviso sumiu | a reconciliação **recria** o aviso de devolução |
| Site reiniciou com a prova em andamento | a prova continua; se o prazo acabar, o servidor encerra ao voltar e gera o ADD |

A reconciliação procura toda tentativa DAFP que:
1. teve a Role base retirada (`dafpBaseRoleRemovedId`);
2. **não** está mais em andamento (encerrada ou excluída);
3. **não** tem `restoreConfirmedAt`.

Para essas, ela garante um aviso de devolução na fila. Ela só para quando o BotGhost confirma. **Preferimos repetir um ADD a arriscar deixar o aluno sem a Role.**

**Tentativa em andamento nunca entra nisso**, com ou sem `removeConfirmedAt`: atraso ou falta do `ack` da remoção **não** é motivo para devolver.

#### Isolamento por tentativa (avisos antigos)
Cada aviso de cargo pertence a **uma** tentativa (`attemptId`, chaves `dafp_started:<tentativa>` e `dafp_restore:<tentativa>`). Um aviso de devolução de uma tentativa **anterior** já encerrada nunca é confundido com a prova atual:
- **Antes de disparar o webhook**, o site confere a tentativa **do próprio aviso**. **Não dispara** (fica `cancelado`, com o motivo no histórico) quando:
  - a tentativa ainda está em andamento;
  - a Role já foi devolvida;
  - o aluno está em outra prova DAFP;
  - (para `dafp_started`) a prova dele já terminou.
- **O `claim` confere de novo:** um `dafp_base_restore` de tentativa em andamento responde `410 nothing_to_do` e **nunca** entrega `ADD`, mesmo que o aviso tenha sido criado indevidamente.
- **Quando a devolução de uma prova é confirmada** e o aluno não tem prova DAFP em andamento, as devoluções **antigas** dele ainda pendentes (mesma Role) são dadas como cumpridas (`restoreConfirmedVia = "superseded"`) e saem da fila.
- Na aba **Integração → Fila de avisos**, cada aviso de cargo mostra **o aluno** e **a tentativa** (`…` + 6 últimos caracteres do `attemptId`). Os campos `attemptId` e `sessionId` do `claim` dizem a qual prova o aviso pertence.

#### Idempotência e ordem
- `ADD` = "garantir que a Role esteja **presente**"; `REMOVE` = "garantir que esteja **ausente**". Repetir qualquer um deixa o mesmo estado.
- **Uma** remoção e **uma** devolução por tentativa (chaves únicas `dafp_started:<tentativa>` e `dafp_restore:<tentativa>`). Encerramentos simultâneos (Finalizar + tempo + admin) geram **um** aviso de cada.
- **Nunca remove depois de devolver:**
  - o `claim` de um `dafp_started` cuja prova já terminou responde `410 nothing_to_do`;
  - uma remoção ainda não executada é cancelada no fim;
  - se o BotGhost confirmar uma remoção **fora da reserva** (venceu enquanto a prova terminava), o site **reabre** a devolução e pede o ADD de novo.
- **Duas provas DAFP do mesmo aluno ao mesmo tempo:** terminar uma enquanto a outra está em andamento **não** devolve a Role, porque o estado desejado ainda é AUSENTE. O `claim` da devolução responde `410 nothing_to_do` e o resultado vem com a posição 1 desligada. Quando a última terminar, a Role volta, e a reconciliação ainda repete o ADD da primeira (seguro).
- Se a Role base já foi devolvida pelo aviso de resultado, o aviso próprio que ainda não saiu é cancelado, e um `claim` atrasado dele responde `410 nothing_to_do`.

---

## F. Fila de avisos: webhook → claim → ações → ack

É a **mesma arquitetura** já usada pelo TCEL; não é um sistema paralelo.

### 1. O site dispara o webhook do BotGhost
`POST https://api.botghost.com/webhook/{bot_id}/{event_id}` — o evento **"TCEL avisos"** já existente, configurado com `BOTGHOST_WEBHOOK_URL` e `BOTGHOST_WEBHOOK_API_KEY` no Render.

As variáveis enviadas ao evento:
- `{tcel_notification_id}`: ID do aviso;
- `{tcel_notification_kind}`: `dafp_started` (início DAFP: remover a Role base), `dafp_base_restore` (DAFP: devolver a Role base), `result` (resultado TCEL **ou** DAFP), `promotion_announcement`, `template_test` ou `panel_update`.

### 2. O evento reserva o aviso (claim)
**`POST /notifications/{tcel_notification_id}/claim`**
- Headers: `Authorization: Bearer <chave>`. Body: `{}`, sem identificação.
- **Só com `200 claimed` o BotGhost executa alguma coisa.** Qualquer outra resposta = **não fazer nada** (nem `ack`):

| HTTP | `code` | Significado |
|---|---|---|
| 409 | `already_claimed` | outra execução está cuidando |
| 409 | `already_delivered` | já foi entregue |
| 409 | `not_ready` | ainda não pode (prova não finalizada, ou uma remoção/devolução da Role base do mesmo aluno está com o BotGhost agora); o site redispara depois sozinho |
| 409 | `ambiguous_needs_review` | o admin precisa conferir o canal |
| 409 | `failed` | falhou; reprocessar no painel |
| 409 | `config_missing` | canal de resultados DAFP não configurado; o site redispara depois |
| 410 | `cancelled` / `nothing_to_do` | nada a fazer. Ex.: a prova terminou antes da remoção do início; a Role base já foi devolvida; o aluno está fazendo outra prova DAFP (a Role continua ausente) |
| 404 | `not_found` | aviso inexistente |

**Campos de controle de TODA reserva `200 claimed`:**

| Campo | Valores / uso |
|---|---|
| `notificationId`, `leaseToken`, `leaseUntil` | reserva (a reserva vale 2 minutos) |
| `kind` | `dafp_started` \| `dafp_base_restore` \| `result` \| `promotion_announcement` \| `template_test` \| `panel_update` |
| **`notificationActionType`** | **`DAFP_STARTED`** \| **`DAFP_FINISHED`** \| `TCEL_RESULT` \| `PROMOTION_ANNOUNCEMENT` \| `TEMPLATE_TEST` \| `PANEL_UPDATE` |
| **`publishMessage`** | `"true"` = publicar/editar a mensagem; `"false"` = **não publicar nada**, só executar os cargos e confirmar |
| `action` | `send` (nova mensagem) \| `edit` (editar `messageId`) \| `none` (sem mensagem) |
| `channelId`, `messageId`, `keepComponents`, `templateKey` | onde e o que publicar |
| `message`, `native.*`, `discordBodyJson` | a mensagem pronta |
| `roleActionsPhase` | `START` \| `FINISH` \| vazio (sem ações) |
| `roleActions` | lista `[{ "action": "ADD"/"REMOVE", "roleId", "memberDiscordId" }]`, só as ações ativas |
| `roleAction1Enabled` … `roleAction3MemberDiscordId` | campos fixos por posição (seção E) |
| `applyRole`, `roleId`, `memberDiscordId` | **LEGADO** (seção I) |

Os avisos DAFP trazem também todos os campos da seção D, incluindo `dafpBaseRoleState`.

**Como identificar cada ação sobre a Role base:**
- **REMOVE** (tirar a Role base): `notificationActionType = "DAFP_STARTED"` e `roleAction1Type = "REMOVE"`. É o **único** caso em que aparece `REMOVE`.
- **ADD** (devolver a Role base): `notificationActionType = "DAFP_FINISHED"` e `roleAction1Type = "ADD"`. Chega de duas formas:
  - no aviso de **devolução** (`kind = dafp_base_restore`, `publishMessage = "false"`): só a posição 1;
  - no aviso de **resultado** (`kind = result`, `publishMessage = "true"`): posição 1 junto com as posições 2 e 3.
- O tipo da ação está **sempre** em `roleActionNType`. O BotGhost não precisa deduzir nada pelo `kind`.

### 3a. Início — `DAFP_STARTED`
Resposta real do claim (`kind = dafp_started`):
```json
{
  "ok": true, "code": "claimed", "message": "Notificação reservada.",
  "data": {
    "notificationId": "6ab7844fc58518746e9be9f6",
    "kind": "dafp_started",
    "leaseToken": "42d5ef4e87f72490c37943fbb750e4e9",
    "leaseUntil": "2026-09-26T08:39:35.315Z",
    "action": "none",
    "channelId": "",
    "messageId": "",
    "keepComponents": "false",
    "renderedRevision": "",
    "templateKey": "",
    "message": { "content": "", "embeds": [], "allowed_mentions": { "parse": [], "users": [], "roles": [] } },
    "native": {}, "discordBodyJson": "",
    "displayText": "Notificação reservada.",
    "notificationActionType": "DAFP_STARTED",
    "publishMessage": "false",
    "applyRole": "false", "roleId": "", "memberDiscordId": "",
    "sessionId": "6ab7844fc58518746e9be9e6", "attemptId": "6ab7844fc58518746e9be9f1", "sessionStatus": "EM_ANDAMENTO",
    "examId": "6ab7844fc58518746e9be9c5", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101", "studentMention": "<@700000000000000101>", "studentDisplayName": "Recruta Lima", "studentAvatarUrl": "",
    "supervisorDiscordId": "700000000000000202", "supervisorMention": "<@700000000000000202>", "supervisorDisplayName": "Cap Souza",
    "score": "", "maxScore": "10", "scoreText": "",
    "autoApproval": "", "passingScore": "", "resultStatus": "", "passed": "",
    "resultRoleId": "", "approvedRoleId": "", "failedRoleId": "", "resultChannelId": "600000000000000009",
    "finishedAt": "", "finishedAtText": "", "resultPublished": "false", "perfectScore": "", "finishReason": "",
    "dafpBaseRoleId": "810000000000000001", "dafpPerfectScoreRoleId": "810000000000000002",
    "roleActionsPhase": "START",
    "roleActions": [ { "action": "REMOVE", "roleId": "810000000000000001", "memberDiscordId": "700000000000000101" } ],
    "roleAction1Enabled": "true", "roleAction1Type": "REMOVE", "roleAction1RoleId": "810000000000000001", "roleAction1MemberDiscordId": "700000000000000101",
    "roleAction2Enabled": "false", "roleAction2Type": "", "roleAction2RoleId": "", "roleAction2MemberDiscordId": "",
    "roleAction3Enabled": "false", "roleAction3Type": "", "roleAction3RoleId": "", "roleAction3MemberDiscordId": ""
  }
}
```
- **O que o BotGhost faz:**
  1. **remover** o cargo `roleAction1RoleId` do membro `roleAction1MemberDiscordId`;
  2. **não publicar nada**;
  3. confirmar com `ack` **sem `messageId`**.
- **Se a remoção falhar** (sem permissão, cargo acima do bot, Discord fora): confirme com `outcome: "failed"` e o motivo. A prova **não** é afetada.

### 3b. Fim — `DAFP_FINISHED`
Resposta real do claim, com **10/10 (gabarito)**:
```json
{
  "ok": true, "code": "claimed", "message": "Notificação reservada.",
  "data": {
    "notificationId": "6ab7844fc58518746e9bea14",
    "kind": "result",
    "leaseToken": "cbc369e09d4a0591dd00f7cd3dfe31c9",
    "leaseUntil": "2026-09-26T08:39:35.422Z",
    "action": "send",
    "channelId": "600000000000000009",
    "messageId": "",
    "keepComponents": "false",
    "renderedRevision": "1",
    "templateKey": "dafp_result",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)",
    "displayText": "RESULTADO DA PROVA",
    "notificationActionType": "DAFP_FINISHED",
    "publishMessage": "true",
    "applyRole": "true", "roleId": "810000000000000003", "memberDiscordId": "700000000000000101",
    "sessionId": "6ab7844fc58518746e9be9e6", "attemptId": "6ab7844fc58518746e9be9f1", "sessionStatus": "FINALIZADA",
    "examId": "6ab7844fc58518746e9be9c5", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101", "studentMention": "<@700000000000000101>", "studentDisplayName": "Recruta Lima", "studentAvatarUrl": "",
    "supervisorDiscordId": "700000000000000202", "supervisorMention": "<@700000000000000202>", "supervisorDisplayName": "Cap Souza",
    "score": "10", "maxScore": "10", "scoreText": "10/10",
    "autoApproval": "true", "passingScore": "7", "resultStatus": "APROVADO", "passed": "true",
    "resultRoleId": "810000000000000003", "approvedRoleId": "810000000000000003", "failedRoleId": "",
    "resultChannelId": "600000000000000009",
    "finishedAt": "2026-09-26T08:37:35.390Z", "finishedAtText": "26/09/2026, 05:37",
    "resultPublished": "false", "perfectScore": "true", "finishReason": "FINALIZADA_PELO_ALUNO",
    "dafpBaseRoleId": "810000000000000001", "dafpPerfectScoreRoleId": "810000000000000002",
    "roleActionsPhase": "FINISH",
    "roleActions": [
      { "action": "ADD", "roleId": "810000000000000001", "memberDiscordId": "700000000000000101" },
      { "action": "ADD", "roleId": "810000000000000003", "memberDiscordId": "700000000000000101" },
      { "action": "ADD", "roleId": "810000000000000002", "memberDiscordId": "700000000000000101" }
    ],
    "roleAction1Enabled": "true", "roleAction1Type": "ADD", "roleAction1RoleId": "810000000000000001", "roleAction1MemberDiscordId": "700000000000000101",
    "roleAction2Enabled": "true", "roleAction2Type": "ADD", "roleAction2RoleId": "810000000000000003", "roleAction2MemberDiscordId": "700000000000000101",
    "roleAction3Enabled": "true", "roleAction3Type": "ADD", "roleAction3RoleId": "810000000000000002", "roleAction3MemberDiscordId": "700000000000000101"
  }
}
```

Nos outros resultados, a única diferença é o bloco de cargos, conforme a tabela da seção E. Respostas reais:
- **8/10 (aprovado):**
  - `perfectScore = "false"`;
  - `roleAction1` = `ADD 810000000000000001`;
  - `roleAction2` = `ADD 810000000000000003`;
  - `roleAction3Enabled = "false"`.
- **6/10 (reprovado):**
  - `resultStatus = "REPROVADO"`, `passed = "false"`, `resultRoleId = ""`;
  - `roleAction1` = `ADD 810000000000000001`;
  - `roleAction2Enabled = "false"` e `roleAction3Enabled = "false"`;
  - legado: `applyRole = "false"`, `roleId = ""`.

> **Resultado DAFP público = Embed montado no BotGhost + botão `VERIFICAR NOTA` (seção K).** O BotGhost monta o Embed com os campos separados acima (`examName`, `supervisorMention`, `studentMention`, `score`, `maxScore`, `resultStatus`). A mensagem pronta abaixo (`data.message`) continua vindo no `claim`, mas **não é obrigatória** para o resultado DAFP.

Mensagem pronta real (`data.message`), modelo **"Resultado DAFP (canal)"** (opcional para o DAFP):
```json
{
  "content": "",
  "embeds": [{
    "title": "RESULTADO DA PROVA", "color": 14427686,
    "footer": { "text": "Finalizada em 26/09/2026, 05:37" },
    "fields": [
      { "name": "Aluno", "value": "<@700000000000000101>", "inline": true },
      { "name": "Avaliador", "value": "<@700000000000000202>", "inline": true },
      { "name": "Prova", "value": "Aspirante", "inline": false },
      { "name": "Nota", "value": "10/10", "inline": true },
      { "name": "Resultado", "value": "APROVADO", "inline": true }
    ]
  }],
  "allowed_mentions": { "parse": [], "users": [], "roles": [] }
}
```
- O modelo é editável no painel: aba **Mensagens do Bot** → "Resultado DAFP (canal)".
- **Variáveis do modelo:**
  - aluno: `[[aluno.mencao]]`, `[[aluno.nome]]`, `[[aluno.discordId]]`;
  - avaliador: `[[avaliador.mencao]]`, `[[avaliador.nome]]`, `[[avaliador.discordId]]`;
  - prova e nota: `[[prova.nome]]`, `[[resultado.nota]]`, `[[resultado.total]]`;
  - aprovação: `[[resultado.status]]`, `[[resultado.notaMinima]]`, `[[resultado.cargoMencao]]`;
  - gabarito: **`[[resultado.gabaritou]]`** (`Sim`/`Não`); a mensagem padrão não usa, fica disponível para editar;
  - outras: `[[resultado.data]]`, `[[resultado.situacao]]`, `[[resultado.tentativa]]`, `[[data]]`.

**O que o BotGhost faz num `DAFP_FINISHED` com `publishMessage = "true"`:**
1. se `roleAction1Enabled = "true"` → **adicionar** `roleAction1RoleId` ao membro `roleAction1MemberDiscordId`;
2. se `roleAction2Enabled = "true"` → **adicionar** `roleAction2RoleId` ao mesmo membro;
3. se `roleAction3Enabled = "true"` → **adicionar** `roleAction3RoleId` ao mesmo membro;
4. **publicar** o resultado — **Embed montado no BotGhost + botão `VERIFICAR NOTA`** (seção K):
   - `action = "send"` → nova mensagem no `channelId`;
   - `action = "edit"` → editar o `messageId` no `channelId` (seção K.6);
5. confirmar com `ack` **com o `messageId`** da mensagem publicada.

**Resultado excluído antes de publicar:** o aviso de resultado é cancelado (nada aparece no canal). A Role base volta pelo aviso de devolução (3c).

**Edições depois da primeira entrega** (`action = "edit"`): as posições 1–3 vêm desligadas. O BotGhost só edita a mensagem (seção K.6).

### 3c. Devolução da Role base — `dafp_base_restore` (`DAFP_FINISHED` sem mensagem)
Criado **em toda** saída de "em andamento" (seção E.1), independente de haver mensagem ou resultado. Resposta real do claim (prova iniciada e **encerrada pelo admin** — cancelamento):
```json
{
  "ok": true,
  "code": "claimed",
  "message": "Notificação reservada.",
  "data": {
    "notificationId": "6ab7893627c8011803034b5a",
    "kind": "dafp_base_restore",
    "leaseToken": "eae30fbbf171699e82434b6d3a637577",
    "leaseUntil": "2026-09-26T09:00:30.253Z",
    "action": "none",
    "channelId": "",
    "messageId": "",
    "keepComponents": "false",
    "renderedRevision": "",
    "templateKey": "",
    "message": {
      "content": "",
      "embeds": [],
      "allowed_mentions": {
        "parse": [],
        "users": [],
        "roles": []
      }
    },
    "native": {},
    "discordBodyJson": "",
    "displayText": "Notificação reservada.",
    "notificationActionType": "DAFP_FINISHED",
    "publishMessage": "false",
    "applyRole": "false",
    "roleId": "",
    "memberDiscordId": "700000000000000101",
    "sessionId": "6ab7893627c8011803034b26",
    "attemptId": "6ab7893627c8011803034b31",
    "sessionStatus": "FINALIZADA",
    "examId": "6ab7893527c8011803034af0",
    "examSlug": "aspirante",
    "examName": "Aspirante",
    "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101",
    "studentMention": "<@700000000000000101>",
    "studentDisplayName": "Aluno 0101",
    "studentAvatarUrl": "",
    "supervisorDiscordId": "700000000000000202",
    "supervisorMention": "<@700000000000000202>",
    "supervisorDisplayName": "Fiscal 0202",
    "score": "10",
    "maxScore": "10",
    "scoreText": "10/10",
    "autoApproval": "false",
    "passingScore": "",
    "resultStatus": "NAO_APLICAVEL",
    "passed": "",
    "resultRoleId": "",
    "approvedRoleId": "",
    "failedRoleId": "",
    "resultChannelId": "600000000000000009",
    "finishedAt": "2026-09-26T08:58:30.221Z",
    "finishedAtText": "26/09/2026, 05:58",
    "resultPublished": "false",
    "perfectScore": "false",
    "finishReason": "ENCERRADA_PELO_ADMIN",
    "dafpBaseRoleId": "810000000000000001",
    "dafpPerfectScoreRoleId": "810000000000000002",
    "dafpBaseRoleState": "DEVOLUCAO_PENDENTE",
    "roleActionsPhase": "FINISH",
    "roleActions": [
      {
        "action": "ADD",
        "roleId": "810000000000000001",
        "memberDiscordId": "700000000000000101"
      }
    ],
    "roleAction1Enabled": "true",
    "roleAction1Type": "ADD",
    "roleAction1RoleId": "810000000000000001",
    "roleAction1MemberDiscordId": "700000000000000101",
    "roleAction2Enabled": "false",
    "roleAction2Type": "",
    "roleAction2RoleId": "",
    "roleAction2MemberDiscordId": "",
    "roleAction3Enabled": "false",
    "roleAction3Type": "",
    "roleAction3RoleId": "",
    "roleAction3MemberDiscordId": ""
  }
}
```
- **O que o BotGhost faz** (é o mesmo ramo `DAFP_FINISHED`, com `publishMessage = "false"`):
  1. **adicionar** `roleAction1RoleId` ao membro `roleAction1MemberDiscordId`;
  2. posições 2 e 3 vêm sempre `"false"`;
  3. **não** publicar nada;
  4. confirmar com `ack` **sem `messageId`**: `{ "leaseToken": "<data.leaseToken>", "outcome": "delivered" }`.
- **Se o ADD falhar:** `ack` com `outcome: "failed"`. A prova continua encerrada, e o site repete o aviso (seção E.1 → Recuperação).
- Respostas reais quando **não há nada a fazer** (o BotGhost só para, sem `ack`):
  - Role já devolvida: `{"ok": false, "code": "nothing_to_do", "message": "A Role base desta prova já foi devolvida.", "data": {"displayText": "A Role base desta prova já foi devolvida."}}` (HTTP 410)
  - aluno fazendo outra prova DAFP: `{"ok": false, "code": "nothing_to_do", "message": "O aluno está fazendo outra prova DAFP agora: a Role base volta quando ela terminar.", "data": {"displayText": "O aluno está fazendo outra prova DAFP agora: a Role base volta quando ela terminar."}}` (HTTP 410)
  - remoção pedida de novo depois do fim: `{"ok": false, "code": "nothing_to_do", "message": "A prova já terminou: a Role base não precisa mais sair.", "data": {"displayText": "A prova já terminou: a Role base não precisa mais sair."}}` (HTTP 410)

### 4. Confirmação (ack)
**`POST /notifications/{tcel_notification_id}/ack`** (Headers: `Authorization`; `Content-Type: application/json`).

| Situação | Body |
|---|---|
| Deu certo **com** mensagem (`publishMessage = "true"`) | `{ "leaseToken": "<data.leaseToken>", "outcome": "delivered", "messageId": "<ID real da mensagem>", "channelId": "<canal>" }` |
| Deu certo **sem** mensagem (`publishMessage = "false"`) | `{ "leaseToken": "<data.leaseToken>", "outcome": "delivered" }` |
| Falhou (cargo ou mensagem) | `{ "leaseToken": "<data.leaseToken>", "outcome": "failed", "error": "<motivo curto>" }` |

**Respostas:**
- `200 acked`, por exemplo, sem mensagem:
  ```json
  { "ok": true, "code": "acked", "message": "Entrega confirmada.", "data": { "notificationId": "6ab7844fc58518746e9be9f6", "messageId": "", "status": "delivered", "displayText": "Entrega confirmada." } }
  ```
- `200 already_acked`: `ack` repetido; nada muda. Real: `{"ok": true, "code": "already_acked", "message": "Confirmação já registrada.", "data": {"notificationId": "6ab7893627c8011803034b5a", "messageId": "", "displayText": "Confirmação já registrada."}}`;
- `200 will_retry` / `200 failed`: falha registrada, com nova tentativa ou esgotada. Real: `{"ok": true, "code": "will_retry", "message": "Falha registrada; nova tentativa mais tarde.", "data": {"displayText": "Falha registrada; nova tentativa mais tarde."}}`;
- `400 invalid_message_id`: aviso **com** mensagem confirmado sem `messageId`;
- `409 lease_mismatch`: a reserva venceu ou foi assumida por outra execução.
  - Reserva vencida de aviso **só de cargos**: volta para a fila e é refeita (seguro), contando como tentativa. Depois de 6 reservas sem `ack`, fica "com falha". **O BotGhost precisa confirmar (`ack`) também os avisos sem mensagem** (`DAFP_STARTED` e `DAFP_FINISHED` com `publishMessage = "false"`); sem isso eles ficam voltando até esgotar.
  - Reserva vencida de **envio de mensagem**: fica "ambígua", e o admin decide no painel.

**O que o `ack` registra na tentativa:**
- `ack` de um `dafp_started` → `removeConfirmedAt`;
- `ack` de um aviso com `roleAction1Type = "ADD"` → `restoreConfirmedAt`, e `dafpBaseRoleState` passa a `DEVOLVIDA`;
- quando o resultado confirma o ADD primeiro, o aviso de devolução que ainda não saiu é cancelado;
- devoluções antigas do mesmo aluno (tentativas anteriores, mesma Role) são dadas como cumpridas (`superseded`), se ele não tem prova DAFP em andamento;
- **só o `ack` do BotGhost confirma cargo.** Se o admin marcar uma entrega "ambígua" como publicada, a devolução própria continua valendo até o BotGhost confirmar;
- `ack` `delivered` de uma remoção cuja reserva já não vale (`409 lease_mismatch`), com a prova já encerrada: o site **reabre** a devolução e pede o ADD de novo.

---

## G. Consulta de resultado (sem fila)

### Uma sessão
**`GET /dafp/sessions/{sessionId}`**
- Headers: `Authorization`. URL Params: identificação.
- Só lê: **nunca recalcula**.
- Traz os campos da seção D e as ações da **fase atual**:
  - `START` com a prova em andamento;
  - `FINISH` depois do fim;
  - vazio na sessão criada.

Resposta real, **em andamento** (trechos):
```json
{
  "ok": true, "code": "dafp_session", "message": "Prova em andamento.",
  "data": {
    "sessionId": "6ab7844fc58518746e9be9e6", "attemptId": "6ab7844fc58518746e9be9f1", "sessionStatus": "EM_ANDAMENTO",
    "examSlug": "aspirante", "examName": "Aspirante",
    "studentDiscordId": "700000000000000101", "supervisorDiscordId": "700000000000000202",
    "score": "", "maxScore": "10", "resultStatus": "", "perfectScore": "", "finishReason": "",
    "dafpBaseRoleId": "810000000000000001", "dafpPerfectScoreRoleId": "810000000000000002",
    "dafpBaseRoleState": "SUSPENSA",
    "roleActionsPhase": "START",
    "roleActions": [ { "action": "REMOVE", "roleId": "810000000000000001", "memberDiscordId": "700000000000000101" } ],
    "roleAction1Enabled": "true", "roleAction1Type": "REMOVE", "roleAction1RoleId": "810000000000000001", "roleAction1MemberDiscordId": "700000000000000101",
    "roleAction2Enabled": "false", "roleAction3Enabled": "false",
    "displayText": "Prova em andamento."
  }
}
```

Resposta real, **finalizada com gabarito** (trechos):
```json
{
  "ok": true, "code": "dafp_session", "message": "Prova finalizada: 10/10 — APROVADO.",
  "data": {
    "sessionStatus": "FINALIZADA", "scoreText": "10/10", "autoApproval": "true", "passingScore": "7",
    "resultStatus": "APROVADO", "passed": "true", "perfectScore": "true", "finishReason": "FINALIZADA_PELO_ALUNO",
    "resultRoleId": "810000000000000003", "resultChannelId": "600000000000000009", "resultPublished": "true",
    "roleActionsPhase": "FINISH",
    "roleAction1Type": "ADD", "roleAction1RoleId": "810000000000000001",
    "roleAction2Type": "ADD", "roleAction2RoleId": "810000000000000003",
    "roleAction3Type": "ADD", "roleAction3RoleId": "810000000000000002",
    "displayText": "Prova finalizada: 10/10 — APROVADO."
  }
}
```

Depois do fim, `dafpBaseRoleState` vem `DEVOLUCAO_PENDENTE` até o BotGhost confirmar o ADD e `DEVOLVIDA` depois (valores reais do teste).

**Erros:** `404 session_not_found` e `409 session_not_dafp`.

**Atenção:** a consulta **não** marca nada como executado. O caminho recomendado para aplicar cargos e publicar é a fila (seção F), que garante "uma vez só". Use a consulta para mostrar ou conferir. `resultPublished = "true"` indica que o webhook já publicou e aplicou.

### Lista de resultados DAFP
**`GET /dafp/results`**
- **URL Params:** identificação + opcionais:
  - `student` (ID ou menção);
  - `examSlug` (ou `examId`);
  - `from` / `to` (`AAAA-MM-DD` ou `DD/MM/AAAA`);
  - `page` (começa em 0);
  - `pageSize` (1–25, padrão 10).
- **O que lista:** só resultados DAFP finalizados, não excluídos e não arquivados, do mais recente ao mais antigo.
- **Cada item** traz os campos da seção D, incluindo `perfectScore`, `finishReason` e as ações de fim.
- **Com exatamente 1 item** (`pageSize=1`), os campos vêm também soltos com prefixo `result`:
  - ex.: `resultScoreText`, `resultPerfectScore`, `resultFinishReason`, `resultSessionId`, `resultStudentMention`;
  - `resultStatus`, `resultRoleId`, `resultChannelId` e `resultPublished` mantêm o próprio nome;
  - com 0 ou vários itens, esses campos vêm vazios e `resultSingle = "false"`.

---

## H. Códigos HTTP (rotas DAFP)

| HTTP | `code` | Quando |
|---|---|---|
| 200 | `dafp_exams`, `dafp_exam`, `ready`, `dafp_session`, `dafp_results`, `dafp_results_empty`, `links_regenerated`, `room_already_created` (repetição), `claimed`, `acked`, `already_acked`, `will_retry` | sucesso |
| 201 | `room_created` | sessão criada (links só aqui) |
| 400 | `invalid_field` (inclui `actorRoleIds` ausente/inválido nas rotas DAFP), `invalid_user`, `supervisor_required`, `supervisor_is_student`, `exam_required`, `idempotency_key_required`, `invalid_json`, `invalid_message_id`, `invalid_outcome`, `invalid_id` | pedido inválido |
| 401 | `unauthorized` | chave ausente ou errada |
| 403 | `guild_not_allowed`, `wrong_channel`, `operators_not_configured`, `operator_not_allowed` | servidor, canal ou professor não autorizados (vem com a mensagem pronta "⛔ …"). No DAFP: `operator_not_allowed` = sem a Role de Professor DAFP em `actorRoleIds` (traz `data.rolesReceived`); `operators_not_configured` = Role não configurada no site |
| 404 | `exam_not_found`, `session_not_found`, `room_not_found`, `not_found` | inexistente |
| 409 | `exam_not_dafp`, `exam_inactive`, `exam_not_eligible`, `room_exists`, `session_not_dafp`, `room_closed`, `regenerate_too_soon`, `idempotency_conflict`, `request_in_progress` | sessão/prova |
| 409 | `already_claimed`, `already_delivered`, `not_ready`, `ambiguous_needs_review`, `failed`, `config_missing`, `lease_mismatch` | fila (claim/ack) |
| 410 | `cancelled`, `nothing_to_do` | aviso sem nada a fazer |
| 413 | `payload_too_large` | corpo acima de 32 KB |
| 429 | `rate_limited` | muitas tentativas |
| 500 | `internal_error`, `render_failed` | erro interno / modelo de mensagem inválido |
| 503 | `integration_disabled`, `integration_not_configured` | integração desligada ou sem chave/servidor |

**Site dormindo** (plano gratuito do Render): o pedido pode demorar mais de 1 minuto ou falhar sem resposta. Mostre a mensagem local ("Site iniciando…") e tente de novo. Os avisos da fila não se perdem: são disparados quando o site acordar.

---

## I. Compatibilidade (campos legados)

| Campo | Situação |
|---|---|
| `applyRole`, `roleId`, `memberDiscordId` (no claim) | **LEGADOS, mantidos.** Hoje significam só o cargo de aprovado: `applyRole = "true"` e `roleId` = cargo de aprovado **só** no primeiro envio de um resultado APROVADO. `memberDiscordId` = aluno. **Não** cobrem a Role base nem o Mérito. **A configuração nova deve usar `roleAction1..3`.** |
| `failedRoleId` | **LEGADO.** Não é mais usado; vem vazio em resultados novos (resultados antigos podem trazer o valor que tinham). |
| `resultRoleId` | Agora só o cargo de aprovado (vazio se não aprovado). |
| Resultado DAFP excluído antes de publicar | Antes vinha como aviso `result` sem mensagem. **Agora** a devolução vem pelo aviso próprio `dafp_base_restore`, com o **mesmo formato** (`DAFP_FINISHED`, `publishMessage = "false"`, só a posição 1). O ramo `DAFP_FINISHED` já existente atende sem mudança. |
| Novo `kind` | `dafp_base_restore`. O TCEL nunca recebe esse aviso. |
| "Professores que podem gerar provas DAFP" (lista de IDs) | **Substituído** pela **Role de Professor DAFP** (`dafp.professorRoleId`), um único ID de cargo. A autorização DAFP deixou de comparar `actorDiscordId` com a configuração e passou a exigir `actorRoleIds`. **Configuração antiga:** se a lista tinha **um** ID (o ID da Role), ele passa a valer como a Role automaticamente e é gravado no campo novo ao salvar a aba. Com **vários** IDs, o painel pede para informar a Role. |
| Rotas | Nenhuma rota foi removida ou renomeada; nenhuma rota nova foi criada nestas atualizações. |

---

## J. PASSO A PASSO NECESSÁRIO NO BOTGHOST

Ordem técnica do que o BotGhost precisa fazer. Os blocos e nomes de variáveis são escolha sua; os endpoints, valores e JSONs são exatos.

### 0. Pré-requisitos (uma vez)
1. **No painel, "Provas & Questões":**
   1. crie as 5 provas com **Grupo = DAFP**: Aspirante, Segundo Tenente, Primeiro Tenente, Capitão e Major;
   2. cadastre as questões de cada uma;
   3. em **⚙ Integração / Resultado**, confira o **identificador (slug)**;
   4. configure **Aprovação automática**, **Nota mínima**, o **ID do cargo de APROVADO** da prova (ex.: Aprovado Prova Aspirante) e, se quiser, o canal próprio.
2. **No painel, "Integração BotGhost → Provas DAFP":**
   1. preencha a **Role de Professor DAFP (ID do cargo)** e o **Canal padrão de resultados DAFP**;
   2. em **Cargos automáticos DAFP**, preencha a **Role obrigatória durante o fluxo** (Bombeiros Militares da Fluxo) e o **Mérito em Proficiência**;
   3. clique em Salvar.
   - **Importante:** só preencha a Role obrigatória **depois** de o evento de webhook (passo 7) estar pronto para `DAFP_STARTED`. Assim que ela é salva, toda prova DAFP iniciada gera um aviso de remoção.
3. **No Discord:** o cargo do bot precisa estar **acima** da Role base, dos cargos de aprovado e do Mérito, com a permissão **Gerenciar Cargos**.
4. **A chave do site** já está em **Manage Secrets** (a mesma do TCEL).

### 0.5 Em TODO pedido `/dafp/*`: identificação + `actorRoleIds`
- `GET /dafp/exams`, `GET /dafp/exams/{ref}`, `POST /dafp/rooms/prepare`, `POST /dafp/rooms`, `POST /dafp/rooms/{id}/regenerate-links`, `GET /dafp/sessions/{id}` e `GET /dafp/results` exigem a Role de Professor DAFP.
- Mande sempre `actorRoleIds` (seção 0.1) junto com `guildId`, `actorDiscordId` e `channelId`.
- `/notifications/...` **não** usa identificação nem `actorRoleIds`: só a chave.

### 1–3. CRIAÇÃO: receber aluno, avaliador e prova
- O comando `/provas-dafp` coleta:
  - **ALUNO:** ID em `student`;
  - **AVALIADOR:** ID em `supervisorDiscordId`;
  - **PROVA:** slug em `examSlug`.
- **Para a PROVA:**
  - **menu dinâmico:** chame antes `GET /dafp/exams` e ligue as opções a `opt{N}Label` / `opt{N}Description` / `opt{N}Value` / `opt{N}Hide`;
  - **ou menu fixo:** com os slugs;
  - **ou texto:** validado com `GET /dafp/exams/{slug}`.

### 4. Criar a sessão
Envie **`POST /dafp/rooms`** (seção C):
```json
{
  "guildId": "<ID do servidor>",
  "actorDiscordId": "<ID de quem executou>",
  "channelId": "<ID do canal>",
  "actorDisplayName": "<nome de quem executou>",
  "actorRoleIds": "<cargos de quem executou: IDs ou menções>",
  "student": "<ID do aluno>",
  "studentDisplayName": "<nome do aluno (opcional)>",
  "studentAvatarUrl": "<URL da foto do aluno (opcional)>",
  "supervisorDiscordId": "<ID do avaliador>",
  "supervisorDisplayName": "<nome do avaliador (opcional)>",
  "examSlug": "<slug escolhido>",
  "idempotencyKey": "<ID da interação>"
}
```
**Nenhum cargo é alterado aqui.**

### 5. Guardar IDs e links
Da resposta `201` (`data`), guarde:
- `sessionId`;
- `studentUrl` e `supervisorUrl`, que só aparecem aqui;
- `studentDiscordId`, `supervisorDiscordId` e `examName`.

Se o `code` for:
- `room_exists` → ofereça **regenerar** (`POST /dafp/rooms/{data.roomId}/regenerate-links`);
- 4xx → mostre `data.displayText` em privado;
- sem resposta → mostre a mensagem local.

### 6. Enviar os links
- `studentUrl` **só ao aluno** e `supervisorUrl` **só ao avaliador**, em privado. Nunca em canal público.
- Opcional: responder ao professor em privado com a mensagem pronta (`data.message` / `data.native`).

### 7. INÍCIO e FIM: o evento de webhook (o mesmo "TCEL avisos")
O evento recebe `{tcel_notification_id}` e `{tcel_notification_kind}` e faz:

1. **`POST /notifications/{tcel_notification_id}/claim`** (body `{}`).
2. **Se não for `200`:** pare. Não faça nada, nem `ack`; o site cuida de tentar de novo.
3. **Se `notificationActionType = "DAFP_STARTED"` (INÍCIO):**
   1. se `roleAction1Enabled = "true"` → **remover** `roleAction1RoleId` do membro `roleAction1MemberDiscordId`;
   2. **não** publicar nada (`publishMessage = "false"`);
   3. `ack`: `{ "leaseToken": "<data.leaseToken>", "outcome": "delivered" }`;
   4. se a remoção falhar → `ack` com `{ "leaseToken": "…", "outcome": "failed", "error": "…" }`.
4. **Se `notificationActionType = "DAFP_FINISHED"` (FIM e DEVOLUÇÃO da Role base):**
   - chega de duas formas: com mensagem (`kind = result`, `publishMessage = "true"`) ou **só a devolução** (`kind = dafp_base_restore`, `publishMessage = "false"`, só a posição 1). **O mesmo ramo atende os dois**, desde que a publicação fique dentro da condição `publishMessage = "true"`:
   1. se `roleAction1Enabled = "true"` → **adicionar** `roleAction1RoleId` (Role base) ao `roleAction1MemberDiscordId`;
   2. se `roleAction2Enabled = "true"` → **adicionar** `roleAction2RoleId` (cargo de aprovado) ao `roleAction2MemberDiscordId`;
   3. se `roleAction3Enabled = "true"` → **adicionar** `roleAction3RoleId` (Mérito em Proficiência) ao `roleAction3MemberDiscordId`;
   4. se `publishMessage = "true"` → publicar o **Embed do resultado com o botão `VERIFICAR NOTA`**, montado no BotGhost com os campos do `claim` (**seção K**):
      - `action = "send"` → nova mensagem no `channelId`;
      - `action = "edit"` → editar o `messageId` no `channelId` (seção K.6);
      - se `publishMessage = "false"` (aviso `dafp_base_restore`): **nada** é publicado, sem Embed e sem botão;
   5. `ack`:
      - com mensagem: `{ "leaseToken": "…", "outcome": "delivered", "messageId": "<ID da mensagem>", "channelId": "<canal>" }`;
      - sem mensagem (`publishMessage = "false"`): `{ "leaseToken": "…", "outcome": "delivered" }`;
      - se algo falhar: `{ "leaseToken": "…", "outcome": "failed", "error": "…" }`.
5. **Qualquer outro `notificationActionType`** (`TCEL_RESULT`, `PROMOTION_ANNOUNCEMENT`, `TEMPLATE_TEST`, `PANEL_UPDATE`): continue **exatamente como já funciona hoje** (publicar/editar e `ack` com `messageId`). As posições de cargo vêm sempre `"false"` nesses avisos.

**Como montar as condições:**
- Uma condição por posição, `roleActionNEnabled = "true"`, cada uma com o bloco de adicionar/remover cargo.
- O tipo da ação está em `roleActionNType` (`ADD`/`REMOVE`), mas as posições são fixas:
  - no início, só a posição 1 é usada, e sempre `REMOVE`;
  - no fim, as três posições, sempre `ADD`.
- Assim dá para usar blocos fixos:
  - "remover cargo" no ramo `DAFP_STARTED`;
  - "adicionar cargo" nos três slots do ramo `DAFP_FINISHED`.
- **Não crie** lógica própria de "quando devolver" no BotGhost (timer, saída do canal, etc.): o site já decide e manda a ordem. Se o BotGhost errar ou cair, o site repete.

### 8. Consultar o resultado (opcional)
- `GET /dafp/sessions/{sessionId}` ou `GET /dafp/results?pageSize=1&student=<ID>`, para mostrar ao professor em privado.
- Esses pedidos só leem; não substituem a fila.

### 9. Resumo do fluxo
```
CRIAÇÃO   professor: /provas-dafp → aluno + avaliador + prova → POST /dafp/rooms
          → links (aluno / avaliador) em privado.  Nenhum cargo muda.
INÍCIO    aluno começa a prova → site cria 1 aviso dafp_started → webhook
          → claim (DAFP_STARTED) → REMOVE Role base → ack (sem messageId)
FIM       aluno termina / tempo esgota (inclui abandono) / admin encerra /
          resultado excluído → a prova sai de "em andamento"
          → aviso dafp_base_restore → webhook → claim (DAFP_FINISHED,
            publishMessage "false") → ADD Role base → ack (sem messageId)
          → se houver resultado: site calcula nota, aprovação e perfectScore
            (uma vez) → webhook → claim (DAFP_FINISHED, publishMessage "true")
            → ADD Role base → [ADD aprovado] → [ADD Mérito]
            → publica o Embed "RESULTADO DA PROVA" + botão VERIFICAR NOTA
            → ack (com messageId)
DEPOIS    alguém clica em VERIFICAR NOTA → só BotGhost/Discord (seção K):
          confere a Role 1261488723615420517 → edita a própria mensagem
          acrescentando "NOTA CONFERIDA POR". Nenhuma chamada ao site.
FALHA     BotGhost/Discord fora → o aviso fica na fila (lastError); o site
          repete e a reconciliação (5 min) garante a devolução até o ack
```

---

## K. RESULTADO DAFP — EMBED + VERIFICAR NOTA

Vale **só** para o grupo **DAFP** (Aspirante, Segundo Tenente, Primeiro Tenente, Capitão e Major). O `/provas-tcel` e o resultado TCEL **não mudam**: continuam com a mensagem pronta de sempre, sem este Embed e sem este botão.

**Divisão de responsabilidades**

| Quem | Faz |
|---|---|
| **Site** | calcula a nota e o resultado, entrega os campos pelo `claim`, controla os cargos, a fila e o `ack` |
| **BotGhost** | monta o Embed e o botão `VERIFICAR NOTA` e publica no canal de resultados DAFP |
| **BotGhost/Discord (depois de publicado)** | processa o clique em `VERIFICAR NOTA` e edita a mensagem, **sem** o site |

### K.1 Quando publicar
Só quando o `claim` responder `200` com:
- `notificationActionType = "DAFP_FINISHED"`;
- `publishMessage = "true"` (aviso `kind = result`, `templateKey = "dafp_result"`).

O aviso **`dafp_base_restore`** (`publishMessage = "false"`) **nunca** publica Embed nem botão: só devolve a Role base (seção F.3c).

### K.2 Campos do `claim` usados no Embed (todos separados, texto simples)
Resposta real do `claim` (Capitão, 8/10, aprovado). Trechos: os demais campos da seção F.2 (legados, `roleActions`, `dafpBaseRole*` etc.) também vêm e foram omitidos aqui:
```json
{
  "ok": true, "code": "claimed", "message": "Notificação reservada.",
  "data": {
    "notificationId": "6ab7974634d51b9594ebc5f3",
    "kind": "result",
    "leaseToken": "db3b8e20522b3972a31a417fab1b186f",
    "leaseUntil": "2026-09-26T10:00:30.897Z",
    "action": "send",
    "channelId": "600000000000000009",
    "messageId": "",
    "templateKey": "dafp_result",
    "notificationActionType": "DAFP_FINISHED",
    "publishMessage": "true",
    "sessionId": "6ab7974634d51b9594ebc5cf",
    "attemptId": "6ab7974634d51b9594ebc5da",
    "sessionStatus": "FINALIZADA",
    "examId": "6ab7974634d51b9594ebc5b0",
    "examSlug": "capitao",
    "examName": "Capitão",
    "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101",
    "studentMention": "<@700000000000000101>",
    "studentDisplayName": "Recruta Lima",
    "studentAvatarUrl": "",
    "supervisorDiscordId": "700000000000000202",
    "supervisorMention": "<@700000000000000202>",
    "supervisorDisplayName": "Cap Souza",
    "score": "8",
    "maxScore": "10",
    "scoreText": "8/10",
    "autoApproval": "true",
    "passingScore": "7",
    "resultStatus": "APROVADO",
    "passed": "true",
    "perfectScore": "false",
    "finishedAt": "2026-09-26T09:58:30.864Z",
    "finishedAtText": "26/09/2026, 06:58",
    "finishReason": "FINALIZADA_PELO_ALUNO",
    "resultChannelId": "600000000000000009",
    "resultPublished": "false",
    "roleActionsPhase": "FINISH",
    "roleAction1Enabled": "true",
    "roleAction1Type": "ADD",
    "roleAction1RoleId": "810000000000000001",
    "roleAction1MemberDiscordId": "700000000000000101",
    "roleAction2Enabled": "true",
    "roleAction2Type": "ADD",
    "roleAction2RoleId": "810000000000000004",
    "roleAction2MemberDiscordId": "700000000000000101",
    "roleAction3Enabled": "false",
    "roleAction3Type": "",
    "roleAction3RoleId": "",
    "roleAction3MemberDiscordId": "",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)"
  }
}
```

| No Embed | Campo do `claim` | Exemplo real |
|---|---|---|
| Título | fixo: `RESULTADO DA PROVA` | RESULTADO DA PROVA |
| **NOME DA PROVA** | `examName` | Capitão |
| **AVALIADOR** | `supervisorMention` (menção pelo ID; **não** usar só `supervisorDisplayName`) | <@700000000000000202> |
| **ALUNO** | `studentMention` (menção pelo ID; **não** usar só `studentDisplayName`) | <@700000000000000101> |
| **RESULTADO** | `score` + " pontos / " + `maxScore` + " pontos" | 8 pontos / 10 pontos |
| **STATUS** | `resultStatus` | APROVADO |

- **Onde publicar:** `channelId`. É o canal próprio da prova (`resultChannelId`) ou, se ela não tiver, o **canal padrão de resultados DAFP** da aba Integração BotGhost.
- **Valores de `resultStatus`:**
  - `APROVADO` e `REPROVADO`: resultados acadêmicos normais (prova com aprovação automática);
  - `NAO_APLICAVEL`: a prova está **sem** aprovação automática, ou foi **encerrada pelo admin** (`finishReason = "ENCERRADA_PELO_ADMIN"`, cancelamento). Para esse caso, sugestão de texto no STATUS: "Nota registrada" ou, com `finishReason = "ENCERRADA_PELO_ADMIN"`, "Encerrada pelo admin". É só exibição; configure como preferir.
- **`score` e `maxScore`** já vêm formatados: inteiros sem casas (`8`) e decimais com vírgula (`7,5`).
- **Campos extras disponíveis** (se quiser usar): `scoreText` (`8/10`), `passed`, `passingScore`, `perfectScore`, `finishReason`, `finishedAtText` (horário de Brasília), `studentAvatarUrl` (miniatura), `examSlug`, `examId`.
- **Cargos:** continuam nas posições `roleAction1..3` (seções E e F). **Nada muda** nos cargos.

### K.3 Como montar a publicação no BotGhost
Dentro do ramo `DAFP_FINISHED` do evento de webhook, na condição `publishMessage = "true"`, **depois** dos três blocos de cargo:

1. Bloco que envia uma mensagem no canal `channelId` (no projeto já usamos **Send or Edit a Message**), com um **Embed**:
   - **Título:** `RESULTADO DA PROVA`;
   - **Campo 1:** nome `NOME DA PROVA`, valor = `examName`;
   - **Campo 2:** nome `AVALIADOR`, valor = `supervisorMention`;
   - **Campo 3:** nome `ALUNO`, valor = `studentMention`;
   - **Campo 4:** nome `RESULTADO`, valor = `score` + ` pontos / ` + `maxScore` + ` pontos`;
   - **Campo 5:** nome `STATUS`, valor = `resultStatus`.
   - O valor de cada campo é a variável da resposta do seu bloco de `claim` (`…response.data.examName` etc.). O nome do bloco é escolha sua.
   - Cor, miniatura, rodapé e ordem visual: livres.
2. **Um botão** nessa mensagem:
   - rótulo **`VERIFICAR NOTA`**;
   - ID recomendado (custom ID), se o BotGhost pedir um: **`dafp_verificar_nota`**. É fixo e igual em todos os resultados, porque o botão sempre age na **própria mensagem** em que está. Ele serve só para o BotGhost distinguir este botão dos outros. **O site nunca recebe nem processa esse ID.**
3. Guarde o **ID da mensagem** publicada, na variável opcional do bloco, como já é feito no painel do `/provatcel`.
4. `ack`:
   ```json
   { "leaseToken": "<data.leaseToken>", "outcome": "delivered", "messageId": "<ID da mensagem publicada>", "channelId": "<data.channelId>" }
   ```
   Resposta real: `{"ok": true, "code": "acked", "message": "Entrega confirmada.", "data": {"notificationId": "6ab7974634d51b9594ebc5f3", "messageId": "910000000000000077", "status": "delivered", "displayText": "Entrega confirmada."}}`

**O `ack` serve só para confirmar a publicação original.** Ele não cria nenhuma dependência do botão com o site.

### K.4 O botão `VERIFICAR NOTA` (100% BotGhost/Discord)
**Quem pode:** só quem tem a Role **`1261488723615420517`**. A verificação é feita **no BotGhost**, com os cargos de quem clicou, e o site **não** valida nada.

**O que o BotGhost faz ao clique** (ações ligadas ao botão):
1. **Condição por cargo:** o usuário que clicou tem a Role `1261488723615420517`?
2. **NÃO tem:**
   - responder **em privado** (resposta escondida, **Hide Replies** ligado), por exemplo: "⛔ Você não tem permissão para conferir esta nota.";
   - **não** editar a mensagem do resultado.
3. **TEM:** **editar a própria mensagem** do resultado (a mensagem onde está o botão):
   - manter **todo** o Embed como está: título e os 5 campos, com os **mesmos valores**;
   - acrescentar **um** campo: nome `NOTA CONFERIDA POR`, valor = menção de quem clicou, `<@ID_DO_USUARIO_QUE_CLICOU>`;
   - manter o botão (ou desativá-lo, se preferir que a conferência seja registrada uma vez só).

**Variáveis do BotGhost usadas no clique** (todas da própria interação, nenhuma do site):
- **ID de quem clicou:** `{user_id}`, a mesma variável já usada neste projeto como "quem clicou" (ver BOTGHOST-MONTAGEM.md). A menção fica `<@{user_id}>`;
- **Cargos de quem clicou:** use a **condição por cargo** do BotGhost, que verifica os cargos do usuário da interação. Não é preciso nenhuma variável do site;
- **Mensagem a editar:** a mensagem do próprio botão, pela opção do bloco de editar a mensagem da interação.

**Não faça no clique:**
- **nenhuma** chamada ao site: nada de `/notifications/…/claim`, `/notifications/…/ack`, `/dafp/results`, `/dafp/sessions` ou qualquer outra rota;
- **nenhum** `claim` ou `ack`: a edição feita pelo botão **não** faz parte da fila;
- nenhum registro no site: a própria mensagem do Discord é o registro visual da conferência.

**Por isso o botão funciona com o Render dormindo, em repouso, fora do ar ou demorando para iniciar:** o clique usa só a interação do Discord, a mensagem existente e as funções do BotGhost.

### K.5 Pontos a CONFIRMAR no editor do BotGhost (não dá para testar do lado do site)
- **Manter o conteúdo na edição.** No Discord, editar um Embed **substitui** o Embed inteiro. O bloco de edição precisa repetir o título e os 5 campos com os mesmos valores, mais o campo novo.
  - Confirme que, dentro das ações do botão, os valores da resposta do `claim` (`…response.data.examName`, `supervisorMention`, `studentMention`, `score`, `maxScore`, `resultStatus`) **continuam disponíveis**, inclusive depois de o bot reiniciar e dias depois da publicação.
  - Se o BotGhost **não** mantiver esses valores no clique, **não edite a mensagem** (apagaria o resultado). Responda em privado que não foi possível registrar a conferência e avise: buscaremos outra forma, **sem** depender do site no clique.
- **Condição por cargo:** confirme o nome exato da condição de cargo no seu editor e teste com uma conta **sem** a Role (precisa receber a resposta privada, e a mensagem precisa ficar igual).
- Teste tudo primeiro num **canal de teste**.

### K.6 Edições posteriores do resultado (vindas do site)
A fila pode mandar um `DAFP_FINISHED` com `action = "edit"` para a mesma mensagem, quando o admin muda o resultado:

| `templateKey` | Quando | O que o BotGhost faz |
|---|---|---|
| `dafp_result` | ajuste no admin (ex.: prova oral lançada, nota ajustada) | **remontar o mesmo Embed** com os valores **atuais** do `claim`, mantendo o botão, e editar `messageId` no `channelId`. Posições de cargo vêm **desligadas**. `ack` com o mesmo `messageId`. |
| `result_removed` | resultado **excluído** depois de publicado | editar `messageId` com a mensagem pronta `data.message` (texto "Resultado removido pelo admin"), **sem** Embed e **sem** botão. `ack` com o mesmo `messageId`. |

Real, edição (`dafp_result`): `action = "edit"`, `messageId = "910000000000000077"`, `channelId = "600000000000000009"`, `scoreText = "8/10"`, `resultStatus = "APROVADO"`, `roleAction1Enabled = "false"`, `roleAction2Enabled = "false"`.

Real, excluído depois de publicado (`result_removed`): `action = "edit"`, `messageId = "910000000000000077"`, `data.message.content = "~~Prova finalizada: <@700000000000000101> — Prova: Capitão~~\nResultado removido pelo admin."`; os campos de nota vêm vazios.

**Atenção:** o site **não** guarda quem conferiu. Numa edição `dafp_result`, rara porque só acontece quando o admin muda o resultado, o Embed é remontado **sem** o campo `NOTA CONFERIDA POR`, e a conferência precisa ser clicada de novo.

### K.7 Resumo
- **Publicar:** `claim` 200 → `DAFP_FINISHED` + `publishMessage = "true"` → cargos 1–3 → Embed + botão `VERIFICAR NOTA` → `ack` com `messageId`.
- **`dafp_base_restore`:** só o cargo, **sem** Embed e **sem** botão, `ack` sem `messageId`.
- **Clique:** só BotGhost/Discord. Tem a Role `1261488723615420517`? Sim → edita a mensagem e acrescenta `NOTA CONFERIDA POR <@quem clicou>`. Não → resposta privada. **Zero** chamadas ao site, nenhum `claim` e nenhum `ack`.
- **O site não tem rota de "verificar nota"**, e isso está coberto por teste automatizado. Não crie nenhuma chamada nova para isso.
