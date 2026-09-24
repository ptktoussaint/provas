# PROVA TCEL BOMBEIROS SUL FLUXO RP

Plataforma de prova online com fiscalização remota via WebRTC (compartilhamento de tela obrigatório). O usuário (dono do projeto) **não programa** — todas as mudanças são feitas por sessões do Claude Code, e ele opera o sistema só pela interface web (painel admin).

Base original: reaproveitado do projeto anterior "UPS FLUXO LIVE" (mesma stack, identidade visual trocada de roxo para vermelho).

## ⚠️ Repositório único: `provas`

Este projeto usa **só `ptktoussaint/provas` (branch `main`)** — é o repositório de trabalho E o que o Render usa para o deploy real. Editar, testar, commitar e dar push sempre aqui.

Existiu um segundo repositório (`ptktoussaint/stage-fx-designer`) usado no início do projeto para desenvolvimento, com o código copiado manualmente para cá a cada mudança. **Isso foi descontinuado por decisão explícita do usuário — não editar, não copiar de lá, não usar esse repositório para mais nada.** Se ele for mencionado em algum commit antigo ou nota do Obsidian, é só histórico.

## Stack

Node.js + Express 4 + Socket.io + MongoDB (Mongoose). Frontend em HTML/CSS/JS puro, servido como estático pelo próprio Express (sem build step, sem framework). Deploy no Render (free tier), banco no MongoDB Atlas.

- `npm test` — roda `test/*.test.js` via `node --test` (unitário, sem precisar de banco).
- `npm run test:integration` — `test-integration/*.test.js` com MongoDB temporário em memória (`mongodb-memory-server`, baixa ~80 MB na 1ª vez) e um Discord FALSO em memória. Nunca chama a API real do Discord.
- `npm run discord` — registra/atualiza o `/provatcel` só no servidor `DISCORD_GUILD_ID` (POST por comando, nunca PUT em massa). O mesmo registro existe como botão na aba Discord do admin (o usuário não tem terminal).
- `npm start` — sobe o servidor (precisa de `MONGODB_URI` e demais env vars, ver `.env.example`).
- Node exigido: `22.x` (`engines` no package.json — o Render segue isso).
- Não há processo de build — editar os arquivos em `public/` e `routes/`/`lib`/`models`/`sockets`/`discord` diretamente.

## Papéis e arquitetura essencial

Três papéis: **Admin** (`/admin`), **Aluno** (`/aluno/:token`), **Fiscal** (`/professor/:token`). O papel de cada conexão (HTTP e socket) é sempre resolvido pelo **servidor a partir da sessão** (`resolveRole()` em `sockets/index.js`), nunca aceito como campo vindo do cliente.

**Regra crítica de sessão**: uma sessão (cookie) só pode representar UM papel por vez. Os handlers de login/identificação (`routes/admin.js`, `routes/student.js`, `routes/proctor.js`) limpam explicitamente os outros papéis da sessão antes de setar o novo — sem isso, testar o link do aluno no mesmo navegador onde o Admin está logado quebra silenciosamente o WebRTC (ver "Bug crítico" abaixo).

- `lib/liveState.js` — estado "ao vivo" em memória (quem está online, status de transmissão). **Não é persistido** — um restart do Render apaga tudo isso (o que sobrevive é só o que está no Mongo).
- `sockets/index.js` — toda a sinalização WebRTC e realtime passa por aqui. `registerStudent`/`registerProctor`/`registerAdmin`.
- WebRTC: uma `RTCPeerConnection` por par aluno↔fiscal, aluno sempre oferta, fiscal/admin sempre responde. TURN configurável via `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` (`lib/turn.js`) — **sem TURN, alunos atrás de NAT/firewall restritivo simplesmente não conseguem transmitir**.
- Todas as rotas e handlers de socket passam por wrappers (`lib/asyncHandler.js`, `lib/safeRouter.js`, `safeOn()`) porque Express 4 não encaminha rejeições de Promise sozinho — sem isso, um erro numa requisição derrubaria o processo inteiro (todas as salas simultâneas).
- Cada `ExamAttempt` é presa ao `_id` da `Room`, nunca ao nome digitado — duas salas com nomes iguais nunca compartilham/sobrescrevem dados. `studentName`/`roomLabel` são copiados na própria tentativa (sobrevivem mesmo se a sala for excluída depois).
- Tokens de aluno/fiscal: só o **hash** é persistido (nunca o token puro) — igual senha. Perder o link exige gerar um novo (invalida o antigo, não afeta quem já está conectado).

## Integração com o Discord (bot próprio)

Guia do usuário: `DISCORD-SETUP.md`. Tudo em `discord/`, carregado só com `DISCORD_ENABLED=true` (senão o discord.js nem é carregado e o site roda igual). Mesmo processo do site, **uma única instância**; nada ali depende de Express/Socket.io (dá para virar worker separado chamando `startDiscord()`).

- **Gateway, intent `Guilds` apenas**; membros consultados por ID via REST. Sem Message Content/Presence/lista de membros. Sem Interactions Endpoint URL.
- **Autorização em TODA interação** (`discord/router.js` → `discord/authz.js`): servidor = `DISCORD_GUILD_ID`, canal = canal do painel, cargo atual do membro na lista da ação (gerar/consultar/promover). Config ausente bloqueia. DM negada. Tentativas negadas vão para `SecurityLog` (`discord_unauthorized`). Cargos de destino da promoção NÃO autorizam nada.
- **Sem estado em memória**: customId carrega o estado (resultados) ou aponta para documento no Mongo (`DiscordRequest`, `PromotionDraft`) — botões antigos funcionam após reinício. Formulário (modal) sempre como PRIMEIRA resposta; o resto faz `defer` antes de trabalho demorado. Respostas efêmeras e `allowedMentions` vazio.
- **Gerar Prova** usa `lib/rooms.js` (o MESMO serviço do painel admin). Idempotente (transição atômica `pending→creating` + índice único `Room.discordRequestId`). Sala aberta existente → tratamento explícito; links só são reexibidos via "Regenerar" (que revoga o link do aluno e o link de fiscal anterior do operador). `Room.discordUserId` é copiado para `ExamAttempt` em `startOrResumeAttempt` — nenhuma rota do aluno toca nisso. Isso identifica o destinatário, NÃO autentica quem abriu o link.
- **Outbox** (`models/DiscordTask`, `lib/outbox.js`, `discord/worker.js`, `discord/processors.js`): finalização da prova grava a nota e só então enfileira `result:<attemptId>:r<revision>`; enfileirar nunca lança. Worker processa uma tarefa por vez, com backoff, e retoma após reinício (`releaseStaleLocks`). Reconciliação a cada 60 s recria tarefas faltantes. Processadores sempre releem o estado atual; revisão antiga é "superseded" (nunca publica nota velha nem ressuscita excluído). Envio ambíguo: `nonce`+`enforceNonce` e busca da mensagem já enviada antes de reenviar.
- **Resultados**: `ExamAttempt.revision` sobe a cada mudança. Nota ajustada (`adjustedScore`) separada da calculada (`score`); efetiva = ajustada ?? calculada; máximo congelado (`maxScore`, ou snapshot × pontos para registros antigos). Exclusão é LÓGICA (`deletedAt` + motivo + `auditTrail`); some das consultas e promoções, fica para auditoria. Tudo em `lib/results.js`.
- **Promoção**: rascunho por operador/servidor com prazo; um usuário por lote; revisão (`discord/preflight.js`, função pura) checa hierarquia/permissões/canal/membro/resultado ANTES de qualquer mudança; confirmação é transição atômica `review→executing` e revalida tudo (hash da revisão). `Promotion.lockKey` único impede promoção duplicada/concorrente; só é removido por "Liberar nova promoção" (admin) ou falha total. Cada etapa (cargo/apelido) tem estado próprio; retomada refaz só o pendente, reconciliando com o estado real do membro. Anúncio é tarefa separada, só com os concluídos (e sem quem já tinha os cargos).
- Encerrar sala no meio da prova (admin) agora passa por `finalizeAttempt(..., 'admin_closed')` — corrige no servidor em vez de deixar nota 0.

## Bug crítico já resolvido (não reintroduzir)

O bug mais difícil deste projeto: sessão do Admin colidindo com a do Aluno/Fiscal fazia o servidor tratar o socket do aluno como admin, quebrando o WebRTC de forma totalmente silenciosa (as respostas da prova continuavam salvando normalmente via HTTP, mascarando o problema). Foi corrigido limpando os outros papéis da sessão em cada login/identify. **Qualquer mudança em `resolveRole()` ou nos handlers de login precisa preservar essa exclusão mútua.**

## Convenções deste projeto

- Comentários no código só quando explicam um "porquê" não óbvio (histórico de bug, decisão contra-intuitiva) — o padrão já usado é `// <explicação em português>`, mantenha o idioma consistente com o resto do arquivo.
- Sempre rodar `npm test` antes de dar como concluído (e `npm run test:integration` se mexer em resultados, finalização, salas ou `discord/`).
- O usuário não sabe ler código — respostas para ele devem ser em português, focadas no efeito prático ("o que muda pra você"), não em detalhes de implementação, a menos que peça.
- Nunca commitar sem o usuário pedir explicitamente (mas commitar/pushar imediatamente quando ele pedir — ele não tem terminal próprio, dependeu disso o projeto inteiro).

## Riscos conhecidos em aberto

- **Uploads (`public/uploads/`) ficam no disco efêmero do Render** — somem a cada redeploy. Sem solução aplicada (decisão consciente do usuário); se precisar resolver, é um disco persistente pago no Render.
- **TURN no plano gratuito da Metered (Open Relay)** é compartilhado publicamente, sem SLA — recomendado migrar para plano pago antes de qualquer prova valendo. Não confirmado se já foi feito.
- **Bot do Discord no Render free tier dorme junto com o site** (~15 min sem acesso HTTP): cliques no Discord falham até o site acordar. Nada se perde (outbox), mas para o bot ficar sempre online o serviço precisa de plano pago.
- **`npm audit`**: 3 alertas moderados de `qs` via Express 4 — já existiam antes da integração com o Discord (não vieram dela).

## Mais detalhes

Uma base de conhecimento mais extensa (histórico completo de bugs investigados, decisões de produto, todas as telas do painel admin) foi entregue ao usuário como notas do Obsidian — não está sincronizada com este repositório, então se ele mencionar algo de lá que não bate com o código atual, confie no código e pergunte a ele em caso de dúvida.
