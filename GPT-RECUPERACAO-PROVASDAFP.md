# Recuperação do site de provas em um novo serviço Render (`provasdafp`)

Relatório para continuar a instalação. **Não contém senhas, tokens, chaves nem URIs com credenciais.** Onde falta um valor, está indicado onde encontrá-lo ou como gerá-lo.

## 0. Situação

**O que aconteceu e o que está disponível:**
- A conta antiga do Render foi suspensa. Settings e Environment estão inacessíveis, então os valores antigos das variáveis não podem ser lidos.
- O MongoDB Atlas continua no ar:
  - cluster: `provas.hpbs5hl.mongodb.net`;
  - banco: **`test`**;
  - usuário do banco: `patrickodontocompany_db_user`.
- Já existe backup (`backup-provasdafp-2026-10-04.archive.gz`, no computador do usuário) com:

  | Coleção | Registros |
  |---|---|
  | provas | 6 |
  | questões | 150 |
  | tentativas | 46 |
  | salas | 24 |
  | usuários administrativos | 2 |

**Regras da recuperação:**
- **Decisão:** conectar o serviço novo ao banco `test` EXISTENTE.
- **Não fazer:** restaurar o backup, criar outro banco, recriar provas ou executar a limpeza de armazenamento.

**Código conferido:**
- Repositório `ptktoussaint/provas`. Não há `render.yaml`, `Procfile`, `Dockerfile`, `.nvmrc` nem `.node-version`; a versão do Node vem de `engines` no `package.json`.
- Branches: `main` e `claude/ups-fluxo-site-memory-abn954` estão no **mesmo commit**, sem diferenças nem commits pendentes.
- Esta entrega acrescenta um commit à `main` com os ajustes da seção 3.3. **Não houve deploy**: não existe serviço ativo, porque o antigo está suspenso e o novo ainda não foi criado.
- O repositório antigo `ptktoussaint/stage-fx-designer` está **descontinuado**. A cópia dele é mais antiga (06/09) que a `main` de `provas`. **Não usar.**
- Não existe `.env` no repositório: o `.gitignore` o exclui. Também não há nenhum arquivo de segredos no ambiente desta análise.

## 1. Configuração do novo serviço (Render → New → Web Service)

| Campo | Valor |
|---|---|
| Source / Repository | `ptktoussaint/provas` (GitHub). A conta nova do Render precisa autorizar o GitHub a ver esse repositório. |
| Branch | `main`. Contém a versão atual correta, confirmada em 04/10/2026, com os ajustes de recuperação. |
| Name | `provasdafp` |
| Runtime / Language | `Node` |
| Region | O código não exige nenhuma. Escolha a região do Render mais próxima da região do cluster no Atlas (veja em Atlas → Clusters → a região aparece no card do cluster). O Render não tem região no Brasil: para cluster AWS São Paulo ou US East, **Virginia (US East)** costuma ter a menor latência. |
| Root Directory | *(vazio — raiz do repositório)* |
| Build Command | `npm ci --omit=dev`. Usa o `package-lock.json` e não instala as dependências de teste. Testado com Node 22. |
| Start Command | `npm start` (equivale a `node server.js`) |
| Versão do Node | **22.x**. Vem de `"engines": { "node": "22.x" }` no `package.json`; não precisa de variável. |
| Health Check Path | **`/healthz`**. Público, **não exige autenticação**, não grava nada e não devolve dados: 200 `{"ok":true}` com o banco conectado, 503 sem ele. **Não use** `/api/integrations/botghost/health`, que exige a chave do BotGhost e responderia 401/503 ao Render. Se o plano não mostrar o campo, siga sem ele. |
| Instance Type | **Free**. Dorme após ~15 min sem acesso; a primeira visita depois disso demora a acordar. Todo estado importante fica no MongoDB. |
| Auto-Deploy | `On Commit`. As atualizações chegam ao site quando entram na `main`. |

**Antes do primeiro deploy, no Atlas:** confira **Network Access**. O Render gratuito não tem IP de saída fixo, então a lista de acesso precisa permitir o serviço novo. Se a entrada `0.0.0.0/0` (Allow access from anywhere) já existia para o serviço antigo, não mude nada.

## 2. Variáveis de ambiente (Render → serviço → Environment)

Todas as variáveis que o código lê estão abaixo. Nenhum valor secreto aparece aqui.

### 2.1 Valores não secretos — pode preencher direto

| Nome | Valor | Finalidade |
|---|---|---|
| `NODE_ENV` | `production` | Modo produção; também faz o npm pular dependências de teste. |
| `COOKIE_SECURE` | `true` | Cookie de sessão só por HTTPS. O Render serve HTTPS. |
| `MONGODB_DB_NAME` | `test` | **Força o banco `test`**, mesmo que a URI venha sem o nome do banco. Vale mais que a URI. |
| `BOTGHOST_INTEGRATION_ENABLED` | `false` no 1º deploy | Liga/desliga a API do BotGhost e o despachante de avisos (ver 4.5). |
| `BOTGHOST_NOTIFICATIONS_ENABLED` | `false` no 1º deploy | Liga/desliga o envio de avisos site → BotGhost (ver 4.5). |
| `BOTGHOST_ALLOWED_GUILD_ID` | ID do servidor do Discord | Não é secreto. No Discord, ative Configurações → Avançado → Modo desenvolvedor, clique com o botão direito no servidor → **Copiar ID do servidor**. Só é necessário a partir da Fase 2. |
| `STUN_URLS` | *(opcional)* `stun:stun.l.google.com:19302` | Já é o padrão do código; pode omitir. |
| `TURN_URLS` | URLs do provedor TURN | Não é secreto. Copie no painel do provedor; as instruções do projeto indicam o Metered/Open Relay. Sem TURN, parte dos alunos atrás de NAT restritivo não consegue transmitir a tela. |
| `TURN_CREDENTIAL_TTL_SECONDS` | `43200` | Só se usar `TURN_SECRET` (opção B). |
| `ATLAS_STORAGE_LIMIT_MB` | *(omitir)* | Padrão 512 (plano M0). |
| `PUBLIC_BASE_URL` | *(omitir)* | Só para domínio próprio: substitui a URL `.onrender.com` nos links. |

**Não criar:**
- `PORT` e `RENDER_EXTERNAL_URL`: o próprio Render define.
- `SEED_ADMIN_USERNAME` e `SEED_ADMIN_PASSWORD`: só servem para um script manual, e o banco já tem 2 administradores.
- **Nenhuma variável com o token do bot do Discord.** O site não usa esse token.

### 2.2 Segredos recuperáveis em arquivos privados locais

**Nenhum encontrado.**
- O repositório não tem `.env` (está no `.gitignore`).
- O ambiente desta análise não tem cópia de segredos.
- O projeto sempre foi configurado direto no painel do Render, então não há indicação de arquivo local com esses valores.
- Se você guardou alguma anotação própria (gerenciador de senhas, bloco de notas), use-a. Nunca cole o conteúdo em chat ou Git.

### 2.3 Segredos que você recupera no Atlas, no BotGhost ou no provedor TURN

| Nome | Finalidade | Onde recuperar |
|---|---|---|
| `MONGODB_URI` | Conexão com o Atlas | Ver detalhes abaixo da tabela. |
| `BOTGHOST_WEBHOOK_URL` | Endereço do evento que o site chama para avisar o BotGhost | BotGhost → seu bot → módulo **Webhooks** → evento usado pelos avisos TCEL/DAFP → URL (formato `https://api.botghost.com/webhook/<bot>/<evento>`). Só é necessário na Fase 3. |
| `BOTGHOST_WEBHOOK_API_KEY` | Chave que o site manda no header `Authorization` (sem "Bearer") ao chamar esse webhook | BotGhost → módulo **Webhooks** → **API Key**. Não é o token do Discord nem a chave do site. |
| `BOTGHOST_SITE_API_KEY` | Chave que o BotGhost envia em `Authorization: Bearer …` em toda chamada ao site (mínimo 32 caracteres) | Está guardada no BotGhost em **Manage Secrets** com o nome **`TCEL_SITE_KEY`**. Se o BotGhost deixar ver o valor, copie-o para o Render. Se não deixar (não foi verificado), trate como perdido (2.4). |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Usuário e senha fixos do TURN (opção A) | Painel do provedor TURN (ex.: Metered → app → credenciais). |
| `TURN_SECRET` | Só se o serviço antigo usava um coturn próprio (opção B) | Arquivo de configuração desse servidor (`static-auth-secret`). Use a opção A **ou** a B, nunca as duas. |

**Como montar `MONGODB_URI`:**
1. Abra Atlas → **Database** → cluster `provas` → **Connect** → **Drivers** e copie a string `mongodb+srv://…`.
2. Ela terá o formato `mongodb+srv://patrickodontocompany_db_user:<SENHA>@provas.hpbs5hl.mongodb.net/?retryWrites=true&w=majority&appName=…`.
3. **Escreva `test` entre a barra e o `?`**, ficando `…mongodb.net/test?retryWrites=true&w=majority&appName=…`.
4. Mantenha os parâmetros `retryWrites`, `w` e `appName` como o Atlas mostrar.
5. Troque `<SENHA>` pela senha do usuário do banco. Se a senha tiver caracteres especiais (`@ : / ? # [ ] %`), eles precisam ir codificados (o Atlas avisa).

**Sobre a senha do banco:**
- É a mesma que você usou para gerar o backup (mongodump) sem erros.
- Só se não tiver mais essa senha: Atlas → **Database Access** → usuário → **Edit** → **Edit Password**. Isso **troca a senha para todo sistema que usa esse usuário**: confira antes que o projeto D.C.C. ou outro app não usa `patrickodontocompany_db_user`.

**Proteção extra:** mesmo que a URI venha sem `/test`, `MONGODB_DB_NAME=test` força o banco certo. Sem os dois, o driver também usaria `test`, que é o padrão; provavelmente foi assim que os dados foram parar lá.

### 2.4 Segredos perdidos — gerar de novo

| Nome | Como gerar | Consequência de trocar |
|---|---|---|
| `SESSION_SECRET` | Texto aleatório longo, com 32 caracteres ou mais (gerenciador de senhas, ou `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`). | Só assina o cookie de sessão; **não criptografa nenhum dado e não valida links**. Efeito: as sessões antigas deixam de valer. Os administradores entram de novo com o mesmo login e senha (senhas em argon2, sem chave extra). Aluno e fiscal só reabrem o link, e o token do link os identifica de novo; prova em andamento é retomada se ainda estiver no prazo. Os cookies antigos eram do domínio antigo, então já não valeriam de qualquer forma. |
| `BOTGHOST_SITE_API_KEY` (só se não puder ser lida no BotGhost) | Pelo terminal, com o comando do `.env.example`. Ou, depois do login no painel novo: aba **Integração BotGhost** → **Gerar chave** → **Copiar**. | Cole a mesma chave no Render (`BOTGHOST_SITE_API_KEY`) **e** no BotGhost → Manage Secrets → editar o valor de **`TCEL_SITE_KEY`**, mantendo o nome. Todos os blocos que usam esse segredo passam a enviar a chave nova sem editar bloco nenhum. Enquanto os dois lados não baterem, o BotGhost recebe 401; **nenhum dado é afetado**. Não reutilize essa chave no D.C.C. |

**Chaves que protegem dados ou links:** foi verificado no código que **nenhum segredo** criptografa dados ou valida links existentes.
- Os links de aluno e fiscal guardam só o **SHA-256 do token**, sem chave (`lib/tokens.js`).
- As senhas usam argon2id sem chave extra.

Por isso trocar `SESSION_SECRET` ou a chave do BotGhost não invalida provas, salas, resultados, senhas nem links.

## 3. Preservação dos dados

### 3.1 O que roda sozinho ao iniciar (`server.js`)

Todas as etapas foram conferidas no código. **Nenhuma apaga, reseta, importa ou sobrescreve dados.**

| Etapa | O que faz |
|---|---|
| `migrateExamGroups` | Só preenche campos **ausentes**: grupo `TCEL` em prova sem grupo e identificador (slug) em prova sem slug. Marca uma prova como `tcel` apenas se nenhuma tiver esse slug. Já rodou no serviço antigo; com dados atuais, não muda nada. |
| `migrateAdminRoles` | Converte contas antigas com perfil `admin` (ou sem perfil) em **administrador principal**. Nunca rebaixa. Se as 2 contas forem antigas, as 2 ficam como principais; confira em **Logins/senhas**. |
| `recoverInterruptedRuns` | Só marca como "interrompida" uma limpeza de armazenamento que estava rodando quando o site caiu. **Não executa limpeza.** |
| Relatório de início (novo, `lib/startupReport.js`) | **Somente leitura.** Escreve nos Logs só contagens e nomes de campos. |
| Índices do Mongoose | Cria índices que faltarem. Não apaga dados. |
| Varredura de prazo (a cada 15 s) | Comportamento normal: prova "em andamento" cujo prazo já passou é finalizada como **tempo esgotado**, com a nota do que foi respondido. Provas que estavam em andamento quando o serviço antigo caiu serão fechadas assim; o relatório de início avisa quantas são. |
| Integração BotGhost | Com `BOTGHOST_INTEGRATION_ENABLED=false`, **não liga nada**: sem despachante, sem reconciliação, e a API responde "desligada". |

**Não rodam no deploy:**
- `scripts/seed-admin.js`: só manual, e só cria se o login não existir.
- A tela "Criar administrador": só aparece se o banco **não tiver nenhum** usuário.
- A limpeza de armazenamento: só com prévia e confirmação pelo administrador principal.

Teste automatizado novo (`test-integration/recovery.integration.test.js`):
- sobe o `server.js` real contra um banco `test` com 6/150/46/24/2 registros;
- confirma que nenhum documento de provas, questões, salas, tentativas, modelos de mensagem e fila foi alterado, e que usuários e senhas ficaram iguais;
- confirma que os Logs não têm a URI nem segredos.

### 3.2 Imagens e uploads

| Onde | Situação |
|---|---|
| Arquivos enviados pelo painel (logo, imagem de fundo, vídeo padrão, imagem e vídeo de cada prova) | Gravados no **disco temporário do Render** (`public/uploads/`), que some a cada deploy. Com a conta antiga suspensa, **estão perdidos**. No banco ficou só o caminho (`/uploads/<arquivo>`), que no serviço novo dá "não encontrado". |
| Links externos (`https://…`) colados no painel no lugar do upload | **Continuam funcionando**: ficam no banco e o arquivo está em outro servidor. |
| Arquivos do próprio código (`public/shared/logo-bg.png`, CSS, JS) | No Git. Sobem com o deploy. |
| Imagens de embeds do bot (Mensagens do Bot) | Só links `https` externos, guardados no banco. Funcionam, salvo se apontarem para o domínio antigo do Render. |

**Campos que podem depender do serviço antigo:**
- `settings.logoUrl`
- `settings.introVideoUrl`
- `settings.theme.backgroundImageUrl`
- `exams.imageUrl`
- `exams.introVideoUrl`

O relatório de início lista nos Logs **quantos** registros de cada campo começam com `/uploads/`, e se há endereços `*.onrender.com` antigos em configurações, provas ou modelos de mensagem. Correção: reenviar o arquivo ou, melhor, colar um link direto externo (que sobrevive a deploys), em Provas & Questões → Configurações / Identidade visual / cada prova.

### 3.3 Ajustes feitos no código para esta recuperação

Todos os testes passam: 65 unitários e 110 de integração.

- `MONGODB_DB_NAME` (opcional): fixa o banco usado.
- `PUBLIC_BASE_URL` (opcional): substitui `RENDER_EXTERNAL_URL` quando houver domínio próprio. Só aceita `http(s)://…`.
- `/healthz`: Health Check público, sem dados.
- Log `[db] MongoDB conectado — banco em uso: "test"`: só o nome do banco.
- `lib/startupReport.js`: relatório de início, somente leitura, com:
  - contagens;
  - **alerta "BANCO VAZIO — PARE"** se o banco não tiver provas nem admins (sinal de banco errado);
  - fila de avisos em aberto;
  - campos com `/uploads/`;
  - endereços antigos.

## 4. Novo domínio e BotGhost

### 4.1 Como o site calcula a URL pública

- A ordem é `PUBLIC_BASE_URL`, depois `RENDER_EXTERNAL_URL`, depois `http://localhost:PORT` (só em teste local).
- O Render define `RENDER_EXTERNAL_URL` sozinho como `https://<nome>.onrender.com`.
- Se o nome `provasdafp` já estiver em uso no Render, ele acrescenta um sufixo. **Confirme a URL real no topo da página do serviço** depois de criado.
- Essa URL só é usada para montar os links de aluno e fiscal que o BotGhost entrega, e para mostrar o "Endereço da API para o BotGhost" na aba Integração.

### 4.2 Domínio, CORS, cookies e origens

**Não há nada a trocar no site.**
- **CORS:** a API não libera outras origens, e o Socket.io usa `origin: false` (mesma origem).
- **CSRF:** compara o `Origin` com o próprio host do pedido, calculado na hora.
- **Cookie:** `provas_live.sid`, sem atributo `domain`, então fica preso ao domínio atual; `SameSite=Lax`; `Secure` com `COOKIE_SECURE=true`.
- **CSP:** só `'self'`.

**Nenhum domínio fixo foi encontrado no código.** Os documentos só usam o exemplo `SEU-SITE.onrender.com`.

**O endereço antigo não está registrado no repositório.** Para descobri-lo, abra qualquer bloco "Send an API Request" no BotGhost (por exemplo, o de health) e veja a URL.

### 4.3 URLs antigas e links existentes

- **Código:** nenhuma.
- **Banco:**
  - os links de prova **não** são guardados, só o hash do token;
  - as respostas guardadas para repetição de pedido do BotGhost nunca têm links e expiram em 7 dias;
  - pode haver endereço antigo em configurações ou modelos de mensagem; o relatório de início avisa.
- **Discord:**
  - respostas privadas antigas com links `https://<antigo>/aluno/<token>` e `/professor/<token>`;
  - os blocos do BotGhost apontando para o domínio antigo.
- **Links existentes:** funcionam **trocando só o domínio** e mantendo caminho e token: `https://<novo>/aluno/<token>` e `https://<novo>/professor/<token>`. O token continua válido porque o banco é o mesmo. Exceções:
  - sala encerrada (link desativado de propósito);
  - link substituído por "Regenerar links" (o anterior foi revogado).
- **Alternativa:** pelo BotGhost, "Regenerar links" já entrega links com o domínio novo e revoga os antigos.

### 4.4 Endpoints usados pelo BotGhost

Base: `https://<novo-domínio>/api/integrations/botghost`.
- **Todos exigem** o header `Authorization: Bearer <TCEL_SITE_KEY>`, inclusive o health.
- Com `BOTGHOST_INTEGRATION_ENABLED=false`, todos respondem "desligada" (503).

| Grupo | Método e caminho |
|---|---|
| Health | `GET /health` |
| Painel | `GET /panel` · `POST /panel/register` |
| TCEL — criação | `GET /exams` · `POST /rooms/prepare` · `POST /rooms` · `POST /rooms/{id}/regenerate-links` |
| DAFP — criação | `GET /dafp/exams` · `GET /dafp/exams/{ref}` · `POST /dafp/rooms/prepare` · `POST /dafp/rooms` · `POST /dafp/rooms/{id}/regenerate-links` · `GET /dafp/sessions/{id}` |
| Resultados | `GET /results` (TCEL) · `GET /dafp/results` (DAFP) |
| Promoções | `GET /promotion-candidates` · `POST /promotion-drafts` · `GET /promotion-drafts/{id}` · `POST /promotion-drafts/{id}/selection` · `POST /promotion-drafts/{id}/members` · `POST /promotion-drafts/{id}/review` · `POST /promotion-drafts/{id}/confirm` · `POST /promotion-drafts/{id}/cancel` · `POST /promotion-jobs/{id}/claim` · `POST /promotion-jobs/{id}/progress` · `GET /promotion-jobs/{id}` · `POST /promotion-jobs/{id}/resume` |
| Avisos (claim/ACK) | `POST /notifications/{tcel_notification_id}/claim` · `POST /notifications/{id}/ack` |

### 4.5 Alterações necessárias no BotGhost

**Só o projeto de provas.** Não mexer no D.C.C.

1. **Em todo bloco "Send an API Request" que chama o site de provas:** troque **só o começo da URL**, de `https://<domínio-antigo>` para `https://<domínio-novo>`.
   - Mantenha o restante do caminho, o método, os headers, o body, as variáveis (`{…}`), "Replace variables in URL" e toda a lógica.
   - Isso vale para os grupos da tabela 4.4: health, painel, TCEL, DAFP, resultados, promoções, claim e ACK.
   - **Não altere** os blocos que chamam `discord.com` com `{TOKEN_SECRET}`.
2. **Manage Secrets → `TCEL_SITE_KEY`:** só mude o **valor** se a chave do site foi gerada de novo (2.4). Não troque o nome.
3. **Módulo Webhooks (evento dos avisos):** nada muda. É o site que chama o BotGhost; a URL e a API Key do módulo só vão para o Render.
4. **Não editar mais nada:** comandos, botões, Embeds, "VERIFICAR NOTA", variáveis e condições ficam como estão.

### 4.6 Ordem segura para religar avisos (sem mensagem nem cargo duplicado)

O site já impede duplicação por desenho:
- um aviso por tentativa (chave única);
- reserva com prazo no `claim`;
- confirmação só por `ack` com o ID real da mensagem;
- reserva de **envio** vencida vira **"ambíguo" e nunca é reenviada sozinha** (o admin decide);
- avisos de cargo DAFP que o claim recusaria nem são disparados.

As fases abaixo dão a chance de conferir o que ficou pendente do serviço antigo antes de qualquer envio.

| Fase | Variáveis | O que acontece |
|---|---|---|
| **1 — primeiro deploy** | `BOTGHOST_INTEGRATION_ENABLED=false`, `BOTGHOST_NOTIFICATIONS_ENABLED=false` | Site e painel funcionam; BotGhost recebe "desligada"; nenhum aviso é criado ou enviado. Validar os itens 5.3 (1 a 7). |
| **2 — integração sem avisos** | `BOTGHOST_INTEGRATION_ENABLED=true`, `BOTGHOST_SITE_API_KEY`, `BOTGHOST_ALLOWED_GUILD_ID`; `BOTGHOST_NOTIFICATIONS_ENABLED=false` | Comandos do BotGhost funcionam (gerar prova, resultados, promoções). A fila é reconciliada e vencimentos são tratados, mas **nenhum webhook é disparado**. Na aba **Integração BotGhost → fila de avisos**: (a) **ambíguos**: confira no canal se a mensagem saiu; se saiu, use "já publicada" com o ID da mensagem; se não, "reenviar"; (b) **pendentes**: saem quando a Fase 3 começar. Resultados não publicados e devoluções de Role base DAFP saem uma vez cada; inícios DAFP de provas já encerradas são retidos sozinhos. Evite aplicar provas DAFP reais nesta fase: a retirada da Role base fica na fila até a Fase 3. |
| **3 — avisos ligados** | `BOTGHOST_NOTIFICATIONS_ENABLED=true`, `BOTGHOST_WEBHOOK_URL`, `BOTGHOST_WEBHOOK_API_KEY` | A fila começa a esvaziar. Acompanhe: cada aviso deve passar a "Entregue" (ACK recebido). Para desligar na hora: `BOTGHOST_NOTIFICATIONS_ENABLED=false` → Save. Nada se perde; fica na fila. |

Faça cada troca de variável **fora de horário de prova**: salvar reinicia o serviço.

## 5. Tutorial literal

### 5.1 Criar o serviço

1. Entre em https://dashboard.render.com com a conta nova.
2. Clique em **New +** → **Web Service**.
3. **Connect a repository:**
   - escolha **GitHub** e autorize, se pedir;
   - selecione `ptktoussaint/provas` → **Connect**. Se o repositório não aparecer, em "Configure account" dê acesso a ele no GitHub.
4. Preencha conforme a tabela da seção 1:
   - **Name:** `provasdafp`
   - **Language:** `Node`
   - **Branch:** `main`
   - **Region:** a escolhida
   - **Root Directory:** vazio
   - **Build Command:** `npm ci --omit=dev`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. Ainda na mesma tela, abra **Environment Variables** e clique **Add Environment Variable** para cada uma:
   - `NODE_ENV` = `production`
   - `COOKIE_SECURE` = `true`
   - `MONGODB_DB_NAME` = `test`
   - `MONGODB_URI` = *(montada como em 2.3; com `/test` antes do `?`)*
   - `SESSION_SECRET` = *(gerado agora — 2.4)*
   - `BOTGHOST_INTEGRATION_ENABLED` = `false`
   - `BOTGHOST_NOTIFICATIONS_ENABLED` = `false`
   - TURN: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` *(do provedor — 2.3)*. Se ainda não tiver, o site sobe sem; só a transmissão de tela fica limitada em algumas redes.
6. **Advanced:**
   - **Health Check Path** = `/healthz`;
   - **Auto-Deploy** = `On Commit`.
7. Clique em **Create Web Service** e acompanhe a aba **Logs**.

### 5.2 Conferir os Logs do primeiro deploy

Devem aparecer:
- `[db] MongoDB conectado — banco em uso: "test" (MONGODB_DB_NAME)`
- `[inicio] banco "test" — provas: 6, questões: 150, tentativas: 46, salas: 24, acessos admin: 2`
- `[botghost] integração desligada (BOTGHOST_INTEGRATION_ENABLED != true).`
- `Provas Live rodando na porta …` e o serviço como **Live**.

**Se aparecer "BANCO VAZIO" ou números diferentes:** **pare**. Não abra o painel e **não crie administrador**. Confira `MONGODB_URI`/`MONGODB_DB_NAME`.

Anote eventuais linhas sobre `/uploads/`, endereços `*.onrender.com` antigos, fila de avisos e "provas em andamento".

### 5.3 Testes de validação

1. **Health Check:** abra `https://<novo>/healthz` → `{"ok":true}`.
2. **Painel e acessos:**
   - abra `https://<novo>/admin`. A tela mostra **"Provas DAFP"** e pede **login**; não pode mostrar "Criar administrador";
   - entre com o seu login principal;
   - **Logins/senhas** deve listar os **2** acessos; confira o perfil de cada um.
3. **Provas e questões:**
   - **Provas & Questões** deve listar **6** provas;
   - a soma do total do banco de questões mostrado em cada prova deve dar **150**.
4. **Resultados e salas:**
   - em **Resultados**, com "Arquivados: Mostrar todos" e "Mostrar excluídos" marcados, devem aparecer **46** tentativas;
   - em **Salas**, com "Mostrar finalizadas" marcado, devem aparecer **24** salas.
5. **Armazenamento:** em **Segurança & Auditoria**, o quadro do cluster deve mostrar o consumo. **Não clique em "Limpar armazenamento".**
6. **Criar sala (teste):**
   - em **Salas**, crie uma sala de uma prova, com aluno "TESTE";
   - abra o link do aluno numa janela anônima. O nome da prova aparece e o link começa com o **domínio novo**;
   - não inicie a prova, volte ao painel e **exclua** essa sala de teste.
7. **Link antigo:** pegue um link de aluno de uma sala ainda aberta, troque só o domínio e abra. Deve carregar a sala.
8. **Fase 2 (BotGhost):**
   - ponha no Render `BOTGHOST_SITE_API_KEY` e `BOTGHOST_ALLOWED_GUILD_ID` e mude `BOTGHOST_INTEGRATION_ENABLED` para `true` → **Save**;
   - no BotGhost, troque o domínio nos blocos (4.5) e rode o bloco de **health**: deve receber 200 com "Site online e chave aceita";
   - no painel, a aba **Integração BotGhost** mostra "Ligada" e "Último pedido autenticado do BotGhost" com a hora do teste;
   - `/provatcel` → Gerar prova (aluno de teste): os links vêm com o domínio novo;
   - `/provas-dafp`, para quem tem a Role de Professor DAFP → criar sala de teste: idem;
   - Conferir resultados: deve listar resultados existentes;
   - **Promoções:** abra um rascunho e **cancele**. **Não confirme promoção real.**
   - Confira e resolva a **fila de avisos** (4.6).
9. **Fase 3 (avisos e cargos):**
   - ponha `BOTGHOST_WEBHOOK_URL` e `BOTGHOST_WEBHOOK_API_KEY` e mude `BOTGHOST_NOTIFICATIONS_ENABLED` para `true` → **Save**;
   - na aba Integração, os avisos pendentes devem ir para "Entregue" (claim e ACK). Ambíguos não são reenviados sozinhos;
   - para testar cargos DAFP, use **uma conta de teste**: iniciar a prova retira a Role base, e finalizar devolve a Role base e aplica o cargo de aprovado conforme a nota.

## 6. Pendências que dependem do usuário

- URL final do serviço (confirmar no Render) e o domínio antigo (ver num bloco do BotGhost).
- Senha do usuário do banco (a mesma do backup) para montar `MONGODB_URI`.
- Saber se o BotGhost permite ler o valor de `TCEL_SITE_KEY`; se não, gerar uma chave nova (2.4).
- Valores do TURN no provedor, e saber se era a opção A ou a B.
- URL e API Key do módulo Webhooks do BotGhost (Fase 3).
- Reenviar logo, fundo, vídeos e imagens que estavam em `/uploads/`, se o relatório de início apontar algum.
