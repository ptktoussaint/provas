# PROVA TCEL BOMBEIROS SUL FLUXO RP

Plataforma de prova online com fiscalização remota via WebRTC (compartilhamento de tela obrigatório). O usuário (dono do projeto) **não programa** — todas as mudanças são feitas por sessões do Claude Code, e ele opera o sistema só pela interface web (painel admin).

Base original: reaproveitado do projeto anterior "UPS FLUXO LIVE" (mesma stack, identidade visual trocada de roxo para vermelho).

## ⚠️ Repositório único: `provas`

Este projeto usa **só `ptktoussaint/provas` (branch `main`)** — é o repositório de trabalho E o que o Render usa para o deploy real. Editar, testar, commitar e dar push sempre aqui.

Existiu um segundo repositório (`ptktoussaint/stage-fx-designer`) usado no início do projeto para desenvolvimento, com o código copiado manualmente para cá a cada mudança. **Isso foi descontinuado por decisão explícita do usuário — não editar, não copiar de lá, não usar esse repositório para mais nada.** Se ele for mencionado em algum commit antigo ou nota do Obsidian, é só histórico.

## Stack

Node.js + Express 4 + Socket.io + MongoDB (Mongoose). Frontend em HTML/CSS/JS puro, servido como estático pelo próprio Express (sem build step, sem framework). Deploy no Render (free tier), banco no MongoDB Atlas.

- `npm test` — roda `test/*.test.js` via `node --test` (unitário, sem precisar de banco).
- `npm run test:integration` — `test-integration/*.test.js` com MongoDB temporário em memória (`mongodb-memory-server`, baixa ~80 MB na 1ª vez), a API do BotGhost num Express de teste e um webhook FALSO. Nunca chama BotGhost nem Discord reais.
- `npm start` — sobe o servidor (precisa de `MONGODB_URI` e demais env vars, ver `.env.example`).
- Node exigido: `22.x` (`engines` no package.json — o Render segue isso).
- Não há processo de build — editar os arquivos em `public/` e `routes/`/`lib`/`models`/`sockets`/`botghost` diretamente.

## Papéis e arquitetura essencial

Três papéis: **Admin** (`/admin`), **Aluno** (`/aluno/:token`), **Fiscal** (`/professor/:token`). O papel de cada conexão (HTTP e socket) é sempre resolvido pelo **servidor a partir da sessão** (`resolveRole()` em `sockets/index.js`), nunca aceito como campo vindo do cliente.

**Regra crítica de sessão**: uma sessão (cookie) só pode representar UM papel por vez. Os handlers de login/identificação (`routes/admin.js`, `routes/student.js`, `routes/proctor.js`) limpam explicitamente os outros papéis da sessão antes de setar o novo — sem isso, testar o link do aluno no mesmo navegador onde o Admin está logado quebra silenciosamente o WebRTC (ver "Bug crítico" abaixo).

- `lib/liveState.js` — estado "ao vivo" em memória (quem está online, status de transmissão). **Não é persistido** — um restart do Render apaga tudo isso (o que sobrevive é só o que está no Mongo).
- `sockets/index.js` — toda a sinalização WebRTC e realtime passa por aqui. `registerStudent`/`registerProctor`/`registerAdmin`.
- WebRTC: uma `RTCPeerConnection` por par aluno↔fiscal, aluno sempre oferta, fiscal/admin sempre responde. TURN configurável via `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` (`lib/turn.js`) — **sem TURN, alunos atrás de NAT/firewall restritivo simplesmente não conseguem transmitir**.
- Todas as rotas e handlers de socket passam por wrappers (`lib/asyncHandler.js`, `lib/safeRouter.js`, `safeOn()`) porque Express 4 não encaminha rejeições de Promise sozinho — sem isso, um erro numa requisição derrubaria o processo inteiro (todas as salas simultâneas).
- Cada `ExamAttempt` é presa ao `_id` da `Room`, nunca ao nome digitado — duas salas com nomes iguais nunca compartilham/sobrescrevem dados. `studentName`/`roomLabel` são copiados na própria tentativa (sobrevivem mesmo se a sala for excluída depois).
- Tokens de aluno/fiscal: só o **hash** é persistido (nunca o token puro) — igual senha. Perder o link exige gerar um novo (invalida o antigo, não afeta quem já está conectado).

## Integração com o bot do BotGhost

O bot do Discord é o do **BotGhost** (hospedado lá, com muitos comandos antigos que NÃO são nossos). O site **não conecta no Discord**: sem Gateway, sem discord.js, sem token do bot, sem registrar comandos. Guias do usuário: `BOTGHOST-API.md` (referência da API), `BOTGHOST-MONTAGEM.md` (blocos no painel do BotGhost), `RENDER-GRATUITO.md`, `CHECKLIST-BOTGHOST.md`, `MENSAGENS-DO-BOT.md`. Tudo em `botghost/`.

- **BotGhost → site**: API máquina-a-máquina `/api/integrations/botghost/*` (`botghost/routes.js`), montada em `server.js` ANTES do `express.json` global, da sessão e do CSRF de `/api` — parser próprio (32 KB), rate limit antes (só falhas) e depois da chave, `Authorization: Bearer BOTGHOST_SITE_API_KEY` com comparação em tempo constante (`botghost/auth.js`). Sem chave ⇒ 503. **Nunca** abrir rotas `/api/admin` para a integração nem remover CSRF/abrir CORS.
- **Operador**: `guildId`/`actorDiscordId`/`channelId` vêm das variáveis da interação no BotGhost; o site confere servidor (`BOTGHOST_ALLOWED_GUILD_ID`), canal do painel (se configurado) e a allowlist de IDs por ação (`generate`/`results`/`promote`, aba Integração). IDs do Discord só como string (número no JSON é recusado).
- **Respostas** sempre `{ ok, code, message, data }` com `data.displayText`; mensagens prontas vêm de `botghost/templates/*` (modelos editáveis na aba "Mensagens do Bot", versões em `MessageTemplate`): `data.native.*` (campos soltos), `data.discordBodyJson` (corpo para a API do Discord, `{}` escapados), `allowed_mentions` sempre explícito, edição/teste nunca pinga. Variáveis `[[...]]` substituídas uma vez; links de prova só no modelo privado `room_created`; URLs de imagem só https público, sem o servidor baixar nada.
- **Idempotência** (`botghost/idempotency.js`, `IntegrationRequest`, TTL 7 dias): chave = `{interaction_id}`; mesmo conteúdo ⇒ mesma resposta, conteúdo diferente ⇒ conflito. A resposta guardada NUNCA tem links (repetição de `/rooms` diz que a sala existe e oferece regenerar, que revoga os links anteriores).
- **Salas** (`botghost/roomsService.js`) usam `lib/rooms.js` (o mesmo serviço do admin); fiscal inicial = operador. `Room.discordUserId` identifica o destinatário, não autentica quem abre o link.
- **Avisos site → BotGhost** (`botghost/notifications.js`, `dispatcher.js`, `webhookClient.js`, `IntegrationNotification`): nota salva primeiro, depois o aviso (um por tentativa, versionado por `ExamAttempt.revision`). O despachante roda no próprio processo, só com o site acordado, e dispara o **Webhook oficial** do BotGhost (`BOTGHOST_WEBHOOK_URL` + API Key do módulo, só o ID do aviso). O evento do BotGhost faz `claim` (reserva atômica 2 min, recebe o conteúdo ATUAL) → publica/edita → `ack` com o ID real. 200 do webhook ≠ entrega. Reserva de ENVIO vencida ⇒ `ambiguous` (nunca reenvia sozinho; admin decide); reserva de EDIÇÃO vencida ⇒ refaz. Disparado e nunca reservado ⇒ volta à fila com backoff. Reconciliação a cada 5 min recria aviso faltante.
- **Promoção** (`botghost/promotionsService.js`): rascunho por operador/servidor com prazo (dono conferido em todo pedido), seleção dinâmica (25 slots `optN*`) ou por usuário (valida todos), um usuário por lote com resultado explícito, revisão com hash, confirmação atômica e revalidada, `Promotion.lockKey` único. Lote = rascunho confirmado; o BotGhost reserva (lease 10 min), relata `precheck`/`result` com evidência (lista de cargos lida do membro, ou modo `status` com os HTTP status de cada pedido) e o site marca cada etapa. Nota mudada antes de começar ⇒ `needs_review`; resultado excluído ⇒ `blocked`; excluído depois de começar ⇒ `conflict`. Anúncio só dos concluídos, em partes de 40, sem repetir.
- **Resultados**: `ExamAttempt.revision` sobe a cada mudança. Resultados gravados antes desse campo não têm `revision` no banco — toda atualização condicional usa `revisionFilter()` (casa 0 com campo ausente; sem isso vincular/editar resultado antigo falhava como "alterado ao mesmo tempo"). Nota final = prova escrita (`adjustedScore` legado ?? `score`) + `oralScore` ("Adicionar Pontos Prova Oral", sem teto — pode passar de 100). `archivedAt` = some do bot (consulta e candidatos à promoção), continua no admin por filtro. Exclusão é LÓGICA (`deletedAt` + motivo + `auditTrail`). Tudo em `lib/results.js`.
- Encerrar sala no meio da prova (admin) passa por `finalizeAttempt(..., 'admin_closed')` — corrige no servidor em vez de deixar nota 0.

## Bug crítico já resolvido (não reintroduzir)

O bug mais difícil deste projeto: sessão do Admin colidindo com a do Aluno/Fiscal fazia o servidor tratar o socket do aluno como admin, quebrando o WebRTC de forma totalmente silenciosa (as respostas da prova continuavam salvando normalmente via HTTP, mascarando o problema). Foi corrigido limpando os outros papéis da sessão em cada login/identify. **Qualquer mudança em `resolveRole()` ou nos handlers de login precisa preservar essa exclusão mútua.**

## Convenções deste projeto

- Comentários no código só quando explicam um "porquê" não óbvio (histórico de bug, decisão contra-intuitiva) — o padrão já usado é `// <explicação em português>`, mantenha o idioma consistente com o resto do arquivo.
- Sempre rodar `npm test` antes de dar como concluído (e `npm run test:integration` se mexer em resultados, finalização, salas ou `botghost/`).
- O usuário não sabe ler código — respostas para ele devem ser em português, focadas no efeito prático ("o que muda pra você"), não em detalhes de implementação, a menos que peça.
- Nunca commitar sem o usuário pedir explicitamente (mas commitar/pushar imediatamente quando ele pedir — ele não tem terminal próprio, dependeu disso o projeto inteiro).

## Riscos conhecidos em aberto

- **Uploads (`public/uploads/`) ficam no disco efêmero do Render** — somem a cada redeploy. Sem solução aplicada (decisão consciente do usuário); se precisar resolver, é um disco persistente pago no Render.
- **TURN no plano gratuito da Metered (Open Relay)** é compartilhado publicamente, sem SLA — recomendado migrar para plano pago antes de qualquer prova valendo. Não confirmado se já foi feito.
- **Render free dorme** (~15 min sem acesso): os botões do BotGhost mostram "Site iniciando…" até alguém abrir o site. Avisos só saem com o site acordado (ficam na fila do Mongo). Decisão do usuário: continuar no gratuito, sem ping/worker.
- **Pendências de validação no BotGhost real** (lista no fim de `BOTGHOST-MONTAGEM.md`): Webhooks no plano do usuário, Raw JSON com uma variável, formato da lista de cargos do membro, respostas privadas após formulário. Nada foi testado num BotGhost real — só com um BotGhost simulado.
- **`npm audit`**: 3 alertas moderados de `qs` via Express 4 — já existiam antes da integração (não vieram dela).

## Mais detalhes

Uma base de conhecimento mais extensa (histórico completo de bugs investigados, decisões de produto, todas as telas do painel admin) foi entregue ao usuário como notas do Obsidian — não está sincronizada com este repositório, então se ele mencionar algo de lá que não bate com o código atual, confie no código e pergunte a ele em caso de dúvida.
