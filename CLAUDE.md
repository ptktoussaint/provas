# PROVA TCEL BOMBEIROS SUL FLUXO RP

Plataforma de prova online com fiscalização remota via WebRTC (compartilhamento de tela obrigatório). O usuário (dono do projeto) **não programa** — todas as mudanças são feitas por sessões do Claude Code, e ele opera o sistema só pela interface web (painel admin).

Base original: reaproveitado do projeto anterior "UPS FLUXO LIVE" (mesma stack, identidade visual trocada de roxo para vermelho).

## ⚠️ Antes de qualquer coisa: DOIS repositórios

Este projeto vive em **dois repositórios GitHub sem remote entre si** — toda mudança precisa ser copiada e commitada manualmente nos dois, sempre:

| Repositório | Branch | Papel |
|---|---|---|
| `ptktoussaint/stage-fx-designer` | `claude/ups-fluxo-site-memory-abn954` | Repositório de trabalho principal (histórico completo de decisões nos commits) |
| `ptktoussaint/provas` | `main` | **É esse que o Render usa para o deploy real** |

Fluxo de trabalho padrão ao final de qualquer mudança:
1. Editar e testar em `stage-fx-designer`.
2. `cp` os arquivos alterados para o clone de `provas` (mesmos caminhos relativos).
3. Rodar `npm test` nos dois.
4. Commitar e `git push` nos dois, com a mesma mensagem.

Esquecer de sincronizar um dos dois é a causa mais comum de "eu já corrigi isso, por que ainda está quebrado no site?" — o site em produção só reflete `provas`.

## Stack

Node.js + Express 4 + Socket.io + MongoDB (Mongoose). Frontend em HTML/CSS/JS puro, servido como estático pelo próprio Express (sem build step, sem framework). Deploy no Render (free tier), banco no MongoDB Atlas.

- `npm test` — roda `test/*.test.js` via `node --test` (unitário, sem precisar de banco).
- `npm start` — sobe o servidor (precisa de `MONGODB_URI` e demais env vars, ver `.env.example`).
- Não há processo de build — editar os arquivos em `public/` e `routes/`/`lib`/`models`/`sockets` diretamente.

## Papéis e arquitetura essencial

Três papéis: **Admin** (`/admin`), **Aluno** (`/aluno/:token`), **Fiscal** (`/professor/:token`). O papel de cada conexão (HTTP e socket) é sempre resolvido pelo **servidor a partir da sessão** (`resolveRole()` em `sockets/index.js`), nunca aceito como campo vindo do cliente.

**Regra crítica de sessão**: uma sessão (cookie) só pode representar UM papel por vez. Os handlers de login/identificação (`routes/admin.js`, `routes/student.js`, `routes/proctor.js`) limpam explicitamente os outros papéis da sessão antes de setar o novo — sem isso, testar o link do aluno no mesmo navegador onde o Admin está logado quebra silenciosamente o WebRTC (ver "Bug crítico" abaixo).

- `lib/liveState.js` — estado "ao vivo" em memória (quem está online, status de transmissão). **Não é persistido** — um restart do Render apaga tudo isso (o que sobrevive é só o que está no Mongo).
- `sockets/index.js` — toda a sinalização WebRTC e realtime passa por aqui. `registerStudent`/`registerProctor`/`registerAdmin`.
- WebRTC: uma `RTCPeerConnection` por par aluno↔fiscal, aluno sempre oferta, fiscal/admin sempre responde. TURN configurável via `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` (`lib/turn.js`) — **sem TURN, alunos atrás de NAT/firewall restritivo simplesmente não conseguem transmitir**.
- Todas as rotas e handlers de socket passam por wrappers (`lib/asyncHandler.js`, `lib/safeRouter.js`, `safeOn()`) porque Express 4 não encaminha rejeições de Promise sozinho — sem isso, um erro numa requisição derrubaria o processo inteiro (todas as salas simultâneas).
- Cada `ExamAttempt` é presa ao `_id` da `Room`, nunca ao nome digitado — duas salas com nomes iguais nunca compartilham/sobrescrevem dados. `studentName`/`roomLabel` são copiados na própria tentativa (sobrevivem mesmo se a sala for excluída depois).
- Tokens de aluno/fiscal: só o **hash** é persistido (nunca o token puro) — igual senha. Perder o link exige gerar um novo (invalida o antigo, não afeta quem já está conectado).

## Bug crítico já resolvido (não reintroduzir)

O bug mais difícil deste projeto: sessão do Admin colidindo com a do Aluno/Fiscal fazia o servidor tratar o socket do aluno como admin, quebrando o WebRTC de forma totalmente silenciosa (as respostas da prova continuavam salvando normalmente via HTTP, mascarando o problema). Foi corrigido limpando os outros papéis da sessão em cada login/identify. **Qualquer mudança em `resolveRole()` ou nos handlers de login precisa preservar essa exclusão mútua.**

## Convenções deste projeto

- Comentários no código só quando explicam um "porquê" não óbvio (histórico de bug, decisão contra-intuitiva) — o padrão já usado é `// <explicação em português>`, mantenha o idioma consistente com o resto do arquivo.
- Sempre rodar `npm test` antes de dar como concluído.
- O usuário não sabe ler código — respostas para ele devem ser em português, focadas no efeito prático ("o que muda pra você"), não em detalhes de implementação, a menos que peça.
- Nunca commitar sem o usuário pedir explicitamente (mas commitar/pushar imediatamente quando ele pedir — ele não tem terminal próprio, dependeu disso o projeto inteiro).

## Riscos conhecidos em aberto

- **Uploads (`public/uploads/`) ficam no disco efêmero do Render** — somem a cada redeploy. Sem solução aplicada (decisão consciente do usuário); se precisar resolver, é um disco persistente pago no Render.
- **TURN no plano gratuito da Metered (Open Relay)** é compartilhado publicamente, sem SLA — recomendado migrar para plano pago antes de qualquer prova valendo. Não confirmado se já foi feito.

## Mais detalhes

Uma base de conhecimento mais extensa (histórico completo de bugs investigados, decisões de produto, todas as telas do painel admin) foi entregue ao usuário como notas do Obsidian — não está sincronizada com este repositório, então se ele mencionar algo de lá que não bate com o código atual, confie no código e pergunte a ele em caso de dúvida.
