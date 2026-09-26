# BOTGHOST — Implementação DAFP (e preservação do TCEL)

Referência técnica para configurar **manualmente** no BotGhost o novo comando `/provas-dafp`, sem mexer no `/provas-tcel` que já funciona. Pode ser entregue a outra IA para virar um tutorial de cliques.

> **Como ler os exemplos**
> - As respostas JSON foram geradas pelo próprio site, em teste automatizado. Os IDs do Discord, os IDs de prova/sessão e os links são **fictícios**.
> - Os campos `message`, `native`, `discordBodyJson` e `discordCallbackJson` (mensagem pronta) aparecem abreviados como `"(...)"`.
> - Nenhuma variável do BotGhost é inventada aqui. Onde aparece `<valor>`, o valor vem da interação ou de uma resposta anterior. O nome da variável do BotGhost que carrega esse valor é você quem escolhe no seu bloco.

---

## 0. Regras comuns a TODOS os pedidos (TCEL e DAFP)

| Item | Valor |
|---|---|
| **Endereço base** | `https://SEU-SITE.onrender.com/api/integrations/botghost` (o endereço exato aparece na aba **Integração BotGhost** do painel) |
| **Cabeçalho obrigatório** | `Authorization: Bearer <chave do site>` (a chave fica em **Manage Secrets** do BotGhost; é a mesma `BOTGHOST_SITE_API_KEY` do Render) |
| **Content-Type** (POST) | `application/json` |
| **Formato de toda resposta** | `{ "ok": true/false, "code": "...", "message": "...", "data": { ... } }` |
| **Campos em `data`** | sempre texto ou número simples; `"true"`/`"false"` são **texto** |
| **`data.displayText`** | sempre presente (texto pronto para mostrar) |
| **IDs do Discord** | sempre **texto entre aspas**. O site recusa ID como número (400), porque número perde dígitos |

**Identificação de quem clicou.** Vai em todo pedido: no **Request Body** dos POST e nos **URL Params** dos GET.

| Campo | Conteúdo |
|---|---|
| `guildId` | ID do servidor onde o comando foi usado |
| `actorDiscordId` | ID de quem executou o comando (o professor) |
| `channelId` | ID do canal onde o comando foi usado |
| `actorDisplayName` | nome exibido de quem executou |

**Chave de repetição (`idempotencyKey`).**
- Obrigatória nos POST que criam algo (criar sessão, regenerar links).
- Use o ID da interação: é o mesmo durante todo aquele clique/formulário.
- O **mesmo pedido repetido** devolve a mesma resposta, **sem criar outra sessão** e **sem mostrar os links de novo**.
- A **mesma chave com conteúdo diferente** devolve `409 idempotency_conflict`.

---

## A. Fluxo TCEL existente (`/provas-tcel`) — NÃO muda

**Nenhuma alteração é necessária no `/provas-tcel` do BotGhost.** As rotas, os parâmetros, o formato das respostas e os códigos continuam iguais.

### Identificação fixa da TCEL
- A prova do fluxo TCEL é **sempre** a prova de **slug `tcel`** (identificador interno fixo), do grupo **TCEL**.
- **Antes** desta versão, o site escolhia a prova do pedido, ou a "prova padrão" da aba Integração, ou a **única** prova apta. Com as provas DAFP cadastradas, a "única prova" deixaria de existir e o comando quebraria. **Isso foi corrigido.**
- **Agora:**
  - o `examId` enviado pelo fluxo TCEL é **ignorado**. Mesmo mandando o ID de uma prova DAFP, a sala é criada na prova `tcel` (testado);
  - se a prova `tcel` estiver desativada ou sem questões ativas, o fluxo TCEL responde `409 exam_not_eligible` e **não** abre outra prova;
  - provas DAFP nunca aparecem em `GET /exams` (lista TCEL), em `GET /results` (Conferir resultados TCEL) nem nos candidatos da promoção TCEL.
- **Migração automática** (no primeiro início do site depois do deploy): a prova TCEL existente recebe `slug = "tcel"` e `group = "TCEL"`.
  - **Como ela é identificada:**
    1. a "prova padrão" da aba Integração;
    2. senão, a prova da sala mais recente criada pelo Discord;
    3. senão, a única prova existente.
  - Se não der para identificar com segurança, nada é marcado. O fluxo TCEL segue a regra antiga, mas **só entre provas TCEL**, e o painel mostra um aviso para marcar a prova (seção **Integração / Resultado**, identificador `tcel`).
- A prova `tcel` não pode trocar de identificador nem de grupo pelo painel.

### Rotas TCEL (sem mudança de contrato)

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/health` | teste da chave (sem identificação) |
| `GET` | `/exams` | prova do fluxo TCEL: agora sempre só a `tcel`, com `choiceRequired = "false"` |
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

Resposta real `201 room_created`:
```json
{
  "ok": true,
  "code": "room_created",
  "message": "Sala criada. Os links vão só nesta resposta privada.",
  "data": {
    "roomId": "6ab77b1ad00dfe16237fd9e2",
    "roomLabel": "Discord B2BDC4",
    "roomCode": "#7fd9e2",
    "examId": "6ab77b19d00dfe16237fd9a0",
    "examName": "Prova Tcel",
    "studentDiscordId": "700000000000000303",
    "studentAvatarSaved": "false",
    "supervisorDiscordId": "",
    "supervisorDisplayName": "",
    "supervisorMention": "",
    "supervisorSelected": "false",
    "studentUrl": "https://provas.example.com/aluno/HKN83UpaJ7Rjexu14DY-HSzUmJ8OT3X05wRZlVt2SMk",
    "supervisorUrl": "https://provas.example.com/professor/GeWwB2I5KEu4X-_zNXz-lJUY9HOdL9AduNYaJz1Fdt8",
    "linksAvailable": "true",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)", "discordCallbackJson": "(...)",
    "displayText": "Sala criada. Os links vão só nesta resposta privada."
  }
}
```

**Retrocompatibilidade confirmada por teste:**
- criar sala sem `examId` → TCEL;
- `examId` de uma prova DAFP no fluxo TCEL → continua TCEL;
- `/exams` → só TCEL;
- links do aluno e do fiscal abrem, o fiscal vê a tela do aluno (WebRTC), a finalização calcula a nota, e o resultado aparece em `/results`;
- a consulta TCEL não mostra resultados DAFP.

---

## B. Listagem das provas DAFP

**`GET /dafp/exams`**
- **Autenticação:** `Authorization: Bearer <chave>` + identificação em **URL Params**.
- **Quem pode usar:** quem está na lista **"Professores que podem gerar provas DAFP"** (aba Integração BotGhost). Essa lista é **separada** das listas TCEL.
- **Canal:** se "Canal do /provas-dafp" estiver preenchido na aba Integração, só esse canal é aceito.
- **O que retorna:** só provas do grupo **DAFP**, **ativas** e com **questões ativas**. A TCEL nunca aparece.

Request (URL Params):
```
GET /dafp/exams?guildId=900000000000000000&actorDiscordId=700000000000000009&channelId=600000000000000001&actorDisplayName=Professor
```

Resposta real `200 dafp_exams`. As opções `opt3…opt25` foram omitidas aqui; elas vêm com `Hide = "true"` quando não há prova.
```json
{
  "ok": true,
  "code": "dafp_exams",
  "message": "2 prova(s) DAFP apta(s).",
  "data": {
    "examCount": "2",
    "exams": [
      { "examId": "6ab77b19d00dfe16237fd9c4", "examSlug": "segundo-tenente", "examName": "Segundo Tenente", "examGroup": "DAFP",
        "questionCount": "10", "pointsPerQuestion": "1", "examMaxScore": "10", "durationMinutes": "120",
        "autoApproval": "true", "passingScore": "7", "approvedRoleId": "800000000000000001", "failedRoleId": "800000000000000002",
        "resultChannelId": "600000000000000009" },
      { "examId": "6ab77b19d00dfe16237fd9ad", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
        "questionCount": "10", "pointsPerQuestion": "1", "examMaxScore": "10", "durationMinutes": "120",
        "autoApproval": "true", "passingScore": "7", "approvedRoleId": "800000000000000001", "failedRoleId": "800000000000000002",
        "resultChannelId": "600000000000000009" }
    ],
    "displayText": "1. Segundo Tenente (segundo-tenente)\n2. Aspirante (aspirante)",
    "opt1Label": "Segundo Tenente", "opt1Description": "10 questões · 120 min · mínimo 7", "opt1Value": "segundo-tenente", "opt1Hide": "false", "opt1Default": "false",
    "opt2Label": "Aspirante", "opt2Description": "10 questões · 120 min · mínimo 7", "opt2Value": "aspirante", "opt2Hide": "false", "opt2Default": "false"
  }
}
```

### Menu de seleção (Select Menu)
O BotGhost **não monta um menu a partir de uma lista (array)**. Por isso o site devolve **25 opções fixas prontas**, cada uma com cinco campos:
- `optNLabel`: texto da opção;
- `optNDescription`: descrição;
- `optNValue`: o **slug** da prova, que é o valor a enviar depois;
- `optNHide`: `"true"` quando a posição está vazia;
- `optNDefault`: `"false"`.

**Como montar:**
- Crie um Select Menu com 25 opções fixas e ligue cada campo da opção N à variável correspondente da resposta.
- A opção escolhida volta como **slug** (ex.: `aspirante`) e vai no campo `examSlug` da criação de sessão.

**Alternativas se o menu dinâmico não funcionar no seu plano/bloco:**
- **Menu com valores fixos:** as 5 opções digitadas à mão, com os valores `aspirante`, `segundo-tenente`, `primeiro-tenente`, `capitao` e `major` — os slugs que você definir no painel.
- **Validar uma prova individualmente:** `GET /dafp/exams/{slug ou examId}` (abaixo).

### Consulta/validação de UMA prova DAFP
**`GET /dafp/exams/{ref}`**, em que `{ref}` é o slug (ex.: `aspirante`) ou o `examId`. Mesma autenticação e identificação.

Resposta real `200 dafp_exam`:
```json
{
  "ok": true, "code": "dafp_exam", "message": "Prova DAFP encontrada.",
  "data": {
    "examId": "6ab77b19d00dfe16237fd9ad", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
    "questionCount": "10", "pointsPerQuestion": "1", "examMaxScore": "10", "durationMinutes": "120",
    "autoApproval": "true", "passingScore": "7", "approvedRoleId": "800000000000000001", "failedRoleId": "800000000000000002",
    "resultChannelId": "600000000000000009",
    "active": "true", "eligible": "true",
    "displayText": "Aspirante (aspirante)"
  }
}
```
- `eligible = "false"`: a prova existe mas está inativa ou sem questões ativas.
- TCEL ou outra prova fora do grupo DAFP → `409 exam_not_dafp`:
```json
{ "ok": false, "code": "exam_not_dafp", "message": "Esta prova não pertence ao grupo DAFP.", "data": { "displayText": "Esta prova não pertence ao grupo DAFP." } }
```
- Prova inexistente → `404 exam_not_found`.

---

## C. Criação da sessão DAFP

**`POST /dafp/rooms`**
- **Headers:** `Authorization: Bearer <chave>` e `Content-Type: application/json`.
- **Permissão:** a lista de professores DAFP.
- **Sessão = sala:** `sessionId` é igual a `roomId`.

### Request Body COMPLETO
| Campo | Obrigatório | Conteúdo |
|---|---|---|
| `guildId` | sim | ID do servidor |
| `actorDiscordId` | sim | ID do professor que executou o `/provas-dafp` |
| `channelId` | sim* | ID do canal (*obrigatório se o canal do /provas-dafp estiver configurado) |
| `actorDisplayName` | não | nome do professor |
| `student` | **sim** | ID do **aluno**, ou a menção `<@ID>` |
| `supervisorDiscordId` | **sim** | ID do **avaliador**, ou a menção `<@ID>`. Precisa ser outra pessoa que não o aluno |
| `examSlug` | **sim** | slug da prova escolhida (ex.: `aspirante`). Aceita também `examId` (o ID da prova) no lugar |
| `studentDisplayName` | não | nome do aluno que aparece na prova. Vazio → `Aluno 1234` (final do ID) |
| `supervisorDisplayName` | não | nome do avaliador. Vazio → `Fiscal 1234` |
| `studentAvatarUrl` | não | foto do aluno: só URL HTTPS do CDN do Discord com o ID do aluno. Qualquer outra coisa é ignorada, sem erro |
| `idempotencyKey` | **sim** | ID da interação (6–100 caracteres: letras, números, `: _ . -`) |

**O que o site valida** (o nome da prova enviado nunca é usado):
1. a prova existe (pelo slug ou ID);
2. está ativa;
3. é do grupo **DAFP**;
4. tem questões ativas, ou seja, pode ser iniciada;
5. o avaliador foi informado e não é o aluno;
6. não há outra sessão aberta do mesmo aluno na mesma prova.

Exemplo real de request:
```json
{
  "guildId": "900000000000000000",
  "actorDiscordId": "700000000000000009",
  "channelId": "600000000000000001",
  "actorDisplayName": "Operador Teste",
  "student": "700000000000000101",
  "studentDisplayName": "Recruta Lima",
  "supervisorDiscordId": "700000000000000202",
  "supervisorDisplayName": "Cap Souza",
  "examSlug": "aspirante",
  "studentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png",
  "idempotencyKey": "1300000000000000001"
}
```

Resposta real COMPLETA `201 room_created`. `message`, `native`, `discordBodyJson` e `discordCallbackJson` trazem a mensagem privada pronta do modelo "Sala criada", com os campos Aluno, Fiscal, Prova, Sala e os dois links.
```json
{
  "ok": true,
  "code": "room_created",
  "message": "Sala criada. Os links vão só nesta resposta privada.",
  "data": {
    "roomId": "6ab77b1ad00dfe16237fd9f9",
    "roomLabel": "Discord D223FC",
    "roomCode": "#7fd9f9",
    "examId": "6ab77b19d00dfe16237fd9ad",
    "examName": "Aspirante",
    "studentDiscordId": "700000000000000101",
    "studentAvatarSaved": "true",
    "supervisorDiscordId": "700000000000000202",
    "supervisorDisplayName": "Cap Souza",
    "supervisorMention": "<@700000000000000202>",
    "supervisorSelected": "true",
    "sessionId": "6ab77b1ad00dfe16237fd9f9",
    "sessionStatus": "CRIADA",
    "examGroup": "DAFP",
    "examSlug": "aspirante",
    "studentMention": "<@700000000000000101>",
    "studentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png",
    "examMaxScore": "10",
    "autoApproval": "true",
    "passingScore": "7",
    "approvedRoleId": "800000000000000001",
    "failedRoleId": "800000000000000002",
    "resultChannelId": "600000000000000009",
    "studentUrl": "https://provas.example.com/aluno/Bx0VR_5zKvpIJcwX3s_Q1sZvv-rLDv63FCNAdzR1PbQ",
    "supervisorUrl": "https://provas.example.com/professor/zKfUc_fe8-wUUx_hAgo-tPSUt5z3afNX3F-g547ADho",
    "linksAvailable": "true",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)", "discordCallbackJson": "(...)",
    "displayText": "Sala criada. Os links vão só nesta resposta privada."
  }
}
```

- **Links:**
  - `studentUrl` é o link do **aluno**; `supervisorUrl` é o link do **avaliador**. O link de fiscal pertence ao avaliador escolhido, **não** a quem clicou.
  - Os links **só aparecem nesta resposta**: o site guarda só o hash do token.
  - Mande cada link só para a pessoa certa, em privado. Nunca em canal público.
- **Repetição** (mesma `idempotencyKey`, mesmo conteúdo): `200 room_already_created`, com `linksAvailable = "false"`, `replayed = "true"` e **sem** `studentUrl`/`supervisorUrl`.
- **Sessão já aberta** para o mesmo aluno e prova: `409 room_exists`. Traz `roomId` e `canRegenerate = "true"`; use a regeneração abaixo.

### Opcional: checar antes de criar
**`POST /dafp/rooms/prepare`** — mesmo body, sem `idempotencyKey`. Não cria nada.
- Resposta `200 ready` com `studentDiscordId`, `studentMention`, `supervisorDiscordId`, `supervisorMention`, `examId`, `examSlug` e `examName`.
- Ou os mesmos erros da criação (`room_exists`, `exam_not_dafp`...).
- Também serve para "acordar" o site no plano gratuito.

### Regenerar links de uma sessão DAFP
**`POST /dafp/rooms/{sessionId}/regenerate-links`** — body: identificação + `idempotencyKey`.
- Novo link do aluno e novo link do **mesmo avaliador**; os antigos param de funcionar.
- Resposta `200 links_regenerated` com `studentUrl`, `supervisorUrl` e `supervisor*`.
- Sessão TCEL nesta rota → `409 session_not_dafp`.

---

## D. Nomes dos campos (DAFP)

**Criação da sessão, consulta da sessão, lista de resultados e notificação usam os mesmos nomes.**

| O quê | Campo |
|---|---|
| ID da sessão | `sessionId` (= `roomId`) |
| ID da tentativa (a prova feita) | `attemptId` (vazio antes de o aluno começar) |
| Status da sessão | `sessionStatus`: `CRIADA` \| `EM_ANDAMENTO` \| `FINALIZADA` \| `ENCERRADA` |
| ID do aluno | `studentDiscordId` |
| Menção do aluno | `studentMention` (`<@ID>`) |
| Nome do aluno | `studentDisplayName` |
| Foto do aluno | `studentAvatarUrl` (vazio se não enviada) |
| ID do avaliador | `supervisorDiscordId` |
| Menção do avaliador | `supervisorMention` (`<@ID>`) |
| Nome do avaliador | `supervisorDisplayName` |
| ID da prova | `examId` |
| Nome da prova | `examName` |
| Slug da prova | `examSlug` |
| Grupo | `examGroup` (`DAFP`) |
| Link do aluno | `studentUrl` (**só** na criação/regeneração) |
| Link do avaliador | `supervisorUrl` (**só** na criação/regeneração) |
| Nota | `score` (texto, ex.: `8`) |
| Nota máxima | `maxScore` (ex.: `10`); na criação: `examMaxScore` |
| Nota formatada | `scoreText` (ex.: `8/10`) |
| Aprovação automática | `autoApproval` (`"true"`/`"false"`) |
| Nota mínima | `passingScore` |
| Aprovado/reprovado | `resultStatus`: `APROVADO` \| `REPROVADO` \| `NAO_APLICAVEL` (sem aprovação automática) |
| Aprovado? (booleano) | `passed` (`"true"`/`"false"`; vazio sem aprovação automática) |
| ID do cargo do resultado | `resultRoleId` (o de aprovado ou o de reprovado; vazio sem aprovação automática) |
| ID do cargo de aprovado | `approvedRoleId` |
| ID do cargo de reprovado | `failedRoleId` |
| ID do canal do resultado | `resultChannelId` (o da prova; se vazio, o **canal padrão DAFP**) |
| Finalizada em | `finishedAt` (ISO 8601, UTC) e `finishedAtText` (horário de Brasília) |
| Resultado já publicado pelo webhook? | `resultPublished` (`"true"`/`"false"`) |

### Regras da nota e da aprovação (calculadas SÓ no servidor)
- **Nota** = acertos × pontos por questão da prova. A **nota máxima** = questões sorteadas × pontos por questão.
- **Aprovação:**
  - com **aprovação automática = Sim**: `APROVADO` se `nota >= notaMinima`; senão `REPROVADO`. Nota **igual** à mínima **aprova** (testado). Não há porcentagem: a nota mínima está na **mesma escala da nota**;
  - com **aprovação automática = Não**: `resultStatus = "NAO_APLICAVEL"`, e `passed` e `resultRoleId` ficam vazios.
- **Cargo:** aprovado → `resultRoleId = approvedRoleId`; reprovado → `resultRoleId = failedRoleId`. Cada prova tem os seus cargos, configurados no painel. Nenhum ID está fixo no código.
- **Congelado na finalização:** a decisão é gravada no resultado **uma vez**, no momento da finalização, com a configuração da prova naquele instante.
  - Mudar a nota mínima ou os cargos depois **não** reescreve resultados antigos.
  - Pontos de prova oral lançados depois no admin **não** alteram a aprovação.
- **Nada vem do navegador:** a nota, a aprovação e o cargo nunca vêm do navegador nem do BotGhost. O servidor corrige a partir das respostas gravadas.

---

## E. Consulta de resultado

### Uma sessão
**`GET /dafp/sessions/{sessionId}`**
- Headers: `Authorization`. URL Params: identificação.
- Só lê o resultado gravado: **nunca recalcula**. Pode ser chamada quantas vezes quiser.

Resposta real, **antes** de o aluno começar (`200 dafp_session`):
```json
{
  "ok": true, "code": "dafp_session", "message": "Sessão criada: o aluno ainda não começou a prova.",
  "data": {
    "sessionId": "6ab77b1ad00dfe16237fd9f9", "attemptId": "", "sessionStatus": "CRIADA",
    "examId": "6ab77b19d00dfe16237fd9ad", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101", "studentMention": "<@700000000000000101>", "studentDisplayName": "Recruta Lima",
    "studentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png",
    "supervisorDiscordId": "700000000000000202", "supervisorMention": "<@700000000000000202>", "supervisorDisplayName": "Cap Souza",
    "score": "", "maxScore": "10", "scoreText": "",
    "autoApproval": "", "passingScore": "", "resultStatus": "", "passed": "",
    "resultRoleId": "", "approvedRoleId": "", "failedRoleId": "", "resultChannelId": "600000000000000009",
    "finishedAt": "", "finishedAtText": "", "resultPublished": "false",
    "displayText": "Sessão criada: o aluno ainda não começou a prova."
  }
}
```

Resposta real, **depois** de finalizada (8 de 10, mínimo 7):
```json
{
  "ok": true, "code": "dafp_session", "message": "Prova finalizada: 8/10 — APROVADO.",
  "data": {
    "sessionId": "6ab77b1ad00dfe16237fd9f9", "attemptId": "6ab77b1ad00dfe16237fda14", "sessionStatus": "FINALIZADA",
    "examId": "6ab77b19d00dfe16237fd9ad", "examSlug": "aspirante", "examName": "Aspirante", "examGroup": "DAFP",
    "studentDiscordId": "700000000000000101", "studentMention": "<@700000000000000101>", "studentDisplayName": "Recruta Lima",
    "studentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png",
    "supervisorDiscordId": "700000000000000202", "supervisorMention": "<@700000000000000202>", "supervisorDisplayName": "Cap Souza",
    "score": "8", "maxScore": "10", "scoreText": "8/10",
    "autoApproval": "true", "passingScore": "7", "resultStatus": "APROVADO", "passed": "true",
    "resultRoleId": "800000000000000001", "approvedRoleId": "800000000000000001", "failedRoleId": "800000000000000002",
    "resultChannelId": "600000000000000009",
    "finishedAt": "2026-09-26T07:58:18.193Z", "finishedAtText": "26/09/2026, 04:58",
    "resultPublished": "false",
    "displayText": "Prova finalizada: 8/10 — APROVADO."
  }
}
```
Erros: `404 session_not_found` e `409 session_not_dafp` (a sessão é TCEL).

### Lista de resultados DAFP
**`GET /dafp/results`**
- **URL Params:** identificação + opcionais:
  - `student` (ID ou menção);
  - `examSlug` (ou `examId`);
  - `from` / `to` (`AAAA-MM-DD` ou `DD/MM/AAAA`);
  - `page` (começa em 0);
  - `pageSize` (1–25, padrão 10).
- **O que lista:** só resultados DAFP finalizados, não excluídos e não arquivados, do mais recente ao mais antigo.
- **Com exatamente 1 item na página** (`pageSize=1`), os campos da prova também vêm soltos com prefixo `result`, prontos para um embed:
  - `resultSessionId`, `resultScoreText`, `resultStudentMention`, `resultSupervisorMention`, `resultExamName`...;
  - `resultStatus`, `resultRoleId` e `resultChannelId` mantêm o próprio nome.

Resposta real (`pageSize=1`, trechos):
```json
{
  "ok": true, "code": "dafp_results", "message": "Página 1 de 1.",
  "data": {
    "total": "1", "page": "0", "pageNumber": "1", "pages": "1", "pageSize": "1",
    "hasPrevious": "false", "hasNext": "false", "previousPage": "0", "nextPage": "0",
    "items": [ { "sessionId": "6ab77b1ad00dfe16237fd9f9", "attemptId": "6ab77b1ad00dfe16237fda14", "sessionStatus": "FINALIZADA", "…": "mesmos campos da seção D" } ],
    "displayText": "**1.** <@700000000000000101> · Recruta Lima — Aspirante — **8/10** — ✅ APROVADO · avaliador <@700000000000000202> · 26/09/2026\n\nPágina 1/1",
    "resultSingle": "true",
    "resultSessionId": "6ab77b1ad00dfe16237fd9f9", "resultAttemptId": "6ab77b1ad00dfe16237fda14", "resultSessionStatus": "FINALIZADA",
    "resultExamId": "6ab77b19d00dfe16237fd9ad", "resultExamSlug": "aspirante", "resultExamName": "Aspirante",
    "resultStudentDiscordId": "700000000000000101", "resultStudentMention": "<@700000000000000101>", "resultStudentDisplayName": "Recruta Lima",
    "resultStudentAvatarUrl": "https://cdn.discordapp.com/avatars/700000000000000101/0123456789abcdef0123456789abcdef.png",
    "resultSupervisorDiscordId": "700000000000000202", "resultSupervisorMention": "<@700000000000000202>", "resultSupervisorDisplayName": "Cap Souza",
    "resultScore": "8", "resultMaxScore": "10", "resultScoreText": "8/10",
    "resultAutoApproval": "true", "resultPassingScore": "7", "resultStatus": "APROVADO", "resultPassed": "true",
    "resultRoleId": "800000000000000001", "resultApprovedRoleId": "800000000000000001", "resultFailedRoleId": "800000000000000002",
    "resultChannelId": "600000000000000009",
    "resultFinishedAt": "2026-09-26T07:58:18.193Z", "resultFinishedAtText": "26/09/2026, 04:58", "resultPublished": "true"
  }
}
```

---

## F. Como o BotGhost fica sabendo que a prova terminou

**Mecanismo:** o mesmo já usado pelo TCEL. Nada novo foi inventado: é o **webhook oficial do BotGhost** com a fila do site (claim → publicar → ack).

1. **O site finaliza a prova e grava o resultado.** Isso acontece quando o aluno clica em Finalizar, quando o tempo esgota ou quando o admin encerra a sala. Em seguida o site cria **um** aviso na fila.
2. **O site dispara o webhook do BotGhost:** `POST https://api.botghost.com/webhook/{bot_id}/{event_id}`. É o mesmo evento **"TCEL avisos"** já usado (variáveis `BOTGHOST_WEBHOOK_URL` e `BOTGHOST_WEBHOOK_API_KEY` no Render), com as variáveis:
   - `{tcel_notification_id}`: ID do aviso;
   - `{tcel_notification_kind}`: `result` (vale para TCEL e DAFP).
3. **O evento do BotGhost reserva o aviso:** `POST /notifications/{tcel_notification_id}/claim` (body `{}`; só a chave, sem identificação). A resposta traz:
   - `action`: `send` (primeira vez) ou `edit` (resultado alterado depois);
   - `channelId`: para DAFP é o canal de resultado DAFP; `messageId` (para editar);
   - a mensagem pronta (`message` / `native` / `discordBodyJson`) do modelo **"Resultado DAFP (canal)"** (`templateKey = dafp_result`);
   - **`applyRole`** (`"true"` só no **primeiro envio** de um resultado com cargo), **`roleId`** (o cargo a aplicar) e **`memberDiscordId`** (o aluno);
   - todos os campos da seção D (`resultStatus`, `scoreText`, `studentMention`, `supervisorMention`...).
4. **O evento publica a mensagem no `channelId`** e, se `applyRole = "true"`, **adiciona o cargo `roleId` ao membro `memberDiscordId`**.
5. **O evento confirma:** `POST /notifications/{tcel_notification_id}/ack`, body:
   ```json
   { "leaseToken": "<data.leaseToken do claim>", "outcome": "delivered", "messageId": "<ID real da mensagem enviada>", "channelId": "<canal>" }
   ```
   Se falhar: `{ "leaseToken": "...", "outcome": "failed", "error": "motivo" }`. O site tenta de novo mais tarde.

Resposta real do claim de um resultado DAFP (trechos):
```json
{
  "ok": true, "code": "claimed", "message": "Notificação reservada.",
  "data": {
    "notificationId": "6ab77b1ad00dfe16237fda22", "kind": "result",
    "leaseToken": "8714a0d9c289436a20fa6e9160bd32e6", "leaseUntil": "2026-09-26T08:00:18.223Z",
    "action": "send", "channelId": "600000000000000009", "messageId": "", "keepComponents": "false", "renderedRevision": "1",
    "templateKey": "dafp_result",
    "message": "(...)", "native": "(...)", "discordBodyJson": "(...)", "displayText": "RESULTADO DA PROVA",
    "applyRole": "true", "roleId": "800000000000000001", "memberDiscordId": "700000000000000101",
    "sessionId": "6ab77b1ad00dfe16237fd9f9", "attemptId": "6ab77b1ad00dfe16237fda14", "sessionStatus": "FINALIZADA",
    "examSlug": "aspirante", "examName": "Aspirante",
    "studentMention": "<@700000000000000101>", "supervisorMention": "<@700000000000000202>",
    "score": "8", "maxScore": "10", "scoreText": "8/10",
    "autoApproval": "true", "passingScore": "7", "resultStatus": "APROVADO", "passed": "true",
    "resultRoleId": "800000000000000001", "approvedRoleId": "800000000000000001", "failedRoleId": "800000000000000002",
    "resultChannelId": "600000000000000009", "finishedAt": "2026-09-26T07:58:18.193Z", "resultPublished": "false"
  }
}
```

A mensagem pronta (`data.message`) do modelo padrão, real:
```json
{
  "content": "",
  "embeds": [{
    "title": "RESULTADO DA PROVA", "color": 14427686,
    "footer": { "text": "Finalizada em 26/09/2026, 04:58" },
    "fields": [
      { "name": "Aluno", "value": "<@700000000000000101>", "inline": true },
      { "name": "Avaliador", "value": "<@700000000000000202>", "inline": true },
      { "name": "Prova", "value": "Aspirante", "inline": false },
      { "name": "Nota", "value": "8/10", "inline": true },
      { "name": "Resultado", "value": "APROVADO", "inline": true }
    ]
  }],
  "allowed_mentions": { "parse": [], "users": [], "roles": [] }
}
```
- O texto e o visual podem ser editados no painel: aba **Mensagens do Bot** → "Resultado DAFP (canal)".
- **Variáveis disponíveis no modelo:**
  - aluno: `[[aluno.mencao]]`, `[[aluno.nome]]`, `[[aluno.discordId]]`;
  - avaliador: `[[avaliador.mencao]]`, `[[avaliador.nome]]`, `[[avaliador.discordId]]`;
  - prova e nota: `[[prova.nome]]`, `[[resultado.nota]]`, `[[resultado.total]]`;
  - aprovação: `[[resultado.status]]`, `[[resultado.notaMinima]]`, `[[resultado.cargoMencao]]`;
  - outras: `[[resultado.data]]`, `[[resultado.situacao]]`, `[[resultado.tentativa]]`, `[[data]]`.
- Em vez da mensagem pronta, você pode montar o seu próprio embed com os campos da seção D, vindos do claim.

**Garantias:**
- Só **um** executor recebe o aviso (reserva atômica).
- Um `ack` repetido não duplica nada.
- Se a reserva de um **envio** vencer sem `ack`, o aviso fica "ambíguo" e **nunca** é reenviado sozinho: o admin resolve na aba Integração.
- Editar o resultado depois (ex.: excluir no admin) gera `action = "edit"` com `applyRole = "false"`. Cargo **nunca** é reaplicado em edição.

**Alternativa sem o módulo Webhooks (ou para conferir na hora):**
- Um botão manual do professor pode consultar `GET /dafp/sessions/{sessionId}`. Quando `sessionStatus = "FINALIZADA"`, o resultado está pronto, com `resultRoleId` e `resultChannelId`.
- **Não há polling automático no site:** o BotGhost não é chamado periodicamente.
- Se usar este caminho para publicar e aplicar o cargo, confira `resultPublished`: `"true"` = o webhook já publicou. Evite publicar duas vezes. Adicionar um cargo que o membro já tem não muda nada no Discord.

**Idempotência da finalização:**
- A passagem "em andamento → finalizada" é **uma escrita condicional única** no banco.
- Clique duplo em Finalizar, refresh, reconexão, tempo esgotado ao mesmo tempo que o botão, ou admin encerrando a sala: **só uma** finalização acontece. Nota, aprovação, evento e aviso são gerados **uma vez** (testado com chamadas simultâneas).
- Consultas posteriores só leem o resultado gravado.

---

## G. Códigos HTTP (rotas DAFP)

| HTTP | `code` | Quando |
|---|---|---|
| 200 | `dafp_exams`, `dafp_exam`, `ready`, `dafp_session`, `dafp_results`, `dafp_results_empty`, `links_regenerated`, `room_already_created` (repetição), `claimed`, `acked`, `already_acked` | sucesso |
| 201 | `room_created` | sessão criada (links só aqui) |
| 400 | `invalid_field` | ID como número, ID malformado, data inválida, `idempotencyKey` inválida |
| 400 | `invalid_user` | aluno/avaliador não é ID nem menção |
| 400 | `supervisor_required` / `supervisor_is_student` | avaliador ausente / avaliador = aluno |
| 400 | `exam_required` | prova não informada |
| 400 | `idempotency_key_required` / `invalid_json` | chave ausente / corpo não é JSON |
| 401 | `unauthorized` | chave ausente ou errada |
| 403 | `guild_not_allowed`, `wrong_channel`, `operators_not_configured`, `operator_not_allowed` | servidor, canal ou professor não autorizados (vem com a mensagem pronta "⛔ …") |
| 404 | `exam_not_found`, `session_not_found`, `room_not_found`, `not_found` | prova, sessão ou rota inexistente |
| 409 | `exam_not_dafp` | prova fora do grupo DAFP (ex.: `tcel`) |
| 409 | `exam_inactive` / `exam_not_eligible` | prova desativada / sem questões ativas |
| 409 | `room_exists` | já há sessão aberta desse aluno nessa prova (`roomId`, `canRegenerate`) |
| 409 | `session_not_dafp`, `room_closed`, `regenerate_too_soon` | regenerar/consultar sessão TCEL, sessão encerrada, clique duplo |
| 409 | `idempotency_conflict`, `request_in_progress` | mesma chave com outro conteúdo / pedido idêntico ainda processando |
| 413 | `payload_too_large` | corpo acima de 32 KB |
| 429 | `rate_limited` | muitas tentativas sem chave ou pedidos demais |
| 500 | `internal_error`, `render_failed` | erro interno / modelo de mensagem inválido (ajuste em Mensagens do Bot) |
| 503 | `integration_disabled`, `integration_not_configured` | integração desligada no Render ou sem chave/servidor configurados |

**Se o site estiver dormindo** (plano gratuito do Render): o pedido pode demorar mais de 1 minuto ou falhar sem resposta. Mostre uma mensagem local ("Site iniciando…") e tente de novo.

---

## H. PASSO A PASSO NECESSÁRIO NO BOTGHOST

Ordem técnica do que o BotGhost precisa fazer. Os blocos e nomes de variáveis são escolha sua; os valores e JSONs são exatos.

### 0. Pré-requisitos (uma vez)
1. **No painel do site, aba "Provas & Questões":**
   1. crie as 5 provas com **Grupo = DAFP**: Aspirante, Segundo Tenente, Primeiro Tenente, Capitão e Major;
   2. cadastre as questões de cada uma;
   3. em **⚙ Integração / Resultado**, confira o **identificador (slug)** de cada prova. Sugeridos: `aspirante`, `segundo-tenente`, `primeiro-tenente`, `capitao` e `major`; eles são gerados a partir do nome;
   4. ainda em Integração / Resultado, se quiser: **Aprovação automática = Sim**, **nota mínima**, **ID do cargo de aprovado**, **ID do cargo de reprovado** e, opcionalmente, o **ID do canal de resultado** da prova.
2. **No painel, aba "Integração BotGhost" → "Provas DAFP":**
   1. preencha **Professores que podem gerar provas DAFP** (IDs);
   2. preencha o **Canal padrão de resultados DAFP**;
   3. opcional: preencha o **Canal do /provas-dafp**;
   4. clique em Salvar.
3. **No Discord:** o cargo do bot precisa estar **acima** dos cargos de aprovado/reprovado, com a permissão **Gerenciar Cargos**.
4. **A chave do site** já está em **Manage Secrets** (a mesma usada pelo TCEL).

### 1–3. Receber aluno, avaliador e prova
- O comando `/provas-dafp` coleta:
  - **ALUNO:** um usuário, cujo ID vai em `student`;
  - **AVALIADOR:** um usuário, cujo ID vai em `supervisorDiscordId`;
  - **PROVA:** o slug, que vai em `examSlug`.
- **Para a PROVA:**
  - **opção A (menu dinâmico):** antes, chame `GET /dafp/exams` e ligue as 25 opções do Select Menu a `opt{N}Label`, `opt{N}Description`, `opt{N}Value` e `opt{N}Hide`. O valor escolhido é o slug;
  - **opção B (menu fixo):** 5 opções digitadas, cujos valores são os slugs configurados no painel;
  - **opção C (texto livre):** valide com `GET /dafp/exams/{slug}` antes de criar.
- **Opcional:** pegue também o nome exibido e a foto (URL do CDN do Discord) do aluno, e o nome do avaliador.

### 4. Criar a sessão
Envie **`POST /dafp/rooms`** com o body da seção C:
```json
{
  "guildId": "<ID do servidor>",
  "actorDiscordId": "<ID de quem executou>",
  "channelId": "<ID do canal>",
  "actorDisplayName": "<nome de quem executou>",
  "student": "<ID do aluno>",
  "studentDisplayName": "<nome do aluno (opcional)>",
  "studentAvatarUrl": "<URL da foto do aluno (opcional)>",
  "supervisorDiscordId": "<ID do avaliador>",
  "supervisorDisplayName": "<nome do avaliador (opcional)>",
  "examSlug": "<slug escolhido>",
  "idempotencyKey": "<ID da interação>"
}
```

### 5. Armazenar IDs e links
Guarde o que vier em `data`:
- `sessionId`, necessário para consultar/regenerar depois;
- `studentUrl` e `supervisorUrl`, que só aparecem nesta resposta;
- `studentDiscordId`, `supervisorDiscordId`, `examName` e `resultChannelId`.

Se o `code` for:
- `room_exists` → ofereça **regenerar** (`POST /dafp/rooms/{data.roomId}/regenerate-links`);
- 4xx → mostre `data.displayText` em privado;
- sem resposta → mostre a mensagem local de site iniciando.

### 6. Enviar os links
- Envie `studentUrl` **só ao aluno** (DM ou resposta privada).
- Envie `supervisorUrl` **só ao avaliador**.
- Opcional: responda ao professor em privado com a mensagem pronta (`data.message` / `data.native`, modelo "Sala criada").
- **Nunca** publique links em canal público.

### 7. Detectar a finalização
- **Recomendado:** o evento de webhook que já existe ("TCEL avisos"). O site dispara o webhook sozinho quando a prova termina (seção F).
- **Alternativa manual:** um botão que consulta `GET /dafp/sessions/{sessionId}` até `sessionStatus = "FINALIZADA"`.

### 8. Consultar o resultado
- **No evento de webhook:** `POST /notifications/{tcel_notification_id}/claim`. Traz tudo, inclusive `applyRole`, `roleId` e `memberDiscordId`.
- **Manualmente:** `GET /dafp/sessions/{sessionId}`, ou `GET /dafp/results?pageSize=1&student=<ID>` para o mais recente.

### 9. Enviar a mensagem
- Publique no canal **`channelId` do claim**. Pela consulta manual, use `resultChannelId`.
- Pode usar a mensagem pronta (`message` / `native` / `discordBodyJson`, modelo "Resultado DAFP (canal)") ou montar a sua com os campos:
  - `studentMention` e `supervisorMention`;
  - `examName`;
  - `scoreText`, que dá o "8/10";
  - `resultStatus`.

Exemplo equivalente ao pedido:
```
RESULTADO DA PROVA
Aluno: <studentMention>
Avaliador: <supervisorMention>
Prova: <examName>
Nota: <scoreText>
Resultado: <resultStatus>
```
- As menções `<@ID>` viram menções reais no Discord.
- Com a mensagem pronta, o `allowed_mentions` controla quem é notificado. Os pings são editáveis em Mensagens do Bot.

### 10. Aplicar o cargo
- **No evento de webhook:**
  - se `applyRole = "true"`, adicione o cargo **`roleId`** ao membro **`memberDiscordId`**;
  - depois, confirme com `ack` (seção F, passo 5);
  - `applyRole = "false"` (edição, TCEL, ou prova sem aprovação automática) → não aplique cargo.
- **Pela consulta manual:** use `resultRoleId` (vazio = não aplicar) no aluno `studentDiscordId`.
- O site **não** remove cargos anteriores. Se quiser remover o cargo oposto, use `approvedRoleId` / `failedRoleId`.

### Observação sobre o evento de webhook existente
- **Não é preciso outro evento.** O mesmo evento "TCEL avisos" já publica qualquer aviso no `channelId` que o claim devolve, então resultados DAFP saem no canal DAFP sem mudança.
- **A única adição necessária é o passo 10:** uma condição `applyRole = "true"` → adicionar o cargo `roleId` ao membro `memberDiscordId`, antes do `ack`.
- O comando `/provas-tcel` **não** precisa de alteração nenhuma.
