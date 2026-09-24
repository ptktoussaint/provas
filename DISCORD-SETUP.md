# Bot do Discord — guia de configuração (para quem não programa)

Este guia explica **só o que depende da sua conta** (Discord e Render). O código já está pronto.

> **Enquanto o bot não estiver configurado, o site funciona exatamente como antes.** Se algo der errado com o Discord, as provas, a transmissão de tela e as notas continuam funcionando.

---

## O que o bot faz

No canal da equipe aparece um painel com 3 botões:

| Botão | O que faz |
|---|---|
| **Gerar Prova** | Você informa o ID (ou a menção) do membro. O bot cria a sala da prova e mostra **só para você** o link do aluno e o seu link de fiscal. |
| **Conferir resultados** | Mostra todas as notas direto do banco do site, com páginas, busca por usuário, filtro por prova e ordenação por data ou nota. |
| **Promover** | Você escolhe quem promover, preenche NOME RP e ID RP de cada um, confere uma revisão e confirma. O bot aplica os cargos e o apelido `『TCEL•B』NOME \| ID` e anuncia no canal de promoções. |

Quando uma prova termina (o aluno finaliza ou o tempo acaba), o bot avisa no canal de resultados:
`Prova finalizada: @pessoa — Nota: 86 / 100 — Prova: NOME DA PROVA`

---

## Dados que você vai precisar juntar

| Dado | Onde usar | Onde conseguir |
|---|---|---|
| Token do bot | Render → `DISCORD_BOT_TOKEN` | Passo 1.4 |
| Application ID | Render → `DISCORD_CLIENT_ID` | Passo 1.2 |
| ID do servidor | Render → `DISCORD_GUILD_ID` | Passo 2 |
| ID do canal do painel (canal restrito da equipe) | Site → aba Discord | Passo 2 |
| ID do canal de resultados (canal restrito) | Site → aba Discord | Passo 2 |
| IDs dos cargos que podem **gerar provas** | Site → aba Discord | Passo 2 |
| IDs dos cargos que podem **consultar notas** | Site → aba Discord | Passo 2 |
| IDs dos cargos que podem **promover** | Site → aba Discord | Passo 2 |

Estes valores **já vêm preenchidos** na aba Discord do site (você pode mudar depois):
- Cargos a adicionar: `1231023397069258844` e `1057349963203498105`
- Cargo a remover: `1057349976482664569`
- Canal de promoções: `1396947587235578017`
- Cargo mencionado no anúncio: `1231023397069258844`
- Modelo do apelido: `『TCEL•B』{nome} | {idRP}`

> ⚠️ Os cargos que o bot **dá** na promoção **não** dão permissão para usar o bot. Quem pode usar o bot é definido **só** pelos cargos de operador.

---

## 1. Criar o bot no Discord Developer Portal

1. Entre em **https://discord.com/developers/applications** com a sua conta do Discord.
2. Clique em **New Application** (canto superior direito). Dê um nome (ex.: `Prova TCEL`), marque a caixinha dos termos e clique em **Create**.
   - Na página **General Information**, copie o **Application ID**. Ele vai em `DISCORD_CLIENT_ID`.
   - Nessa mesma página, deixe o campo **Interactions Endpoint URL** **VAZIO**. O bot recebe os cliques por outro caminho.
3. No menu da esquerda, clique em **Installation**:
   - Em **Installation Contexts**, deixe marcado só **Guild Install**.
   - Em **Install Link**, escolha **None**. Você vai usar o link de convite gerado pelo site.
4. No menu da esquerda, clique em **Bot**:
   - Clique em **Reset Token** e confirme. Se o Discord pedir, digite o código de verificação em duas etapas.
   - Clique em **Copy**. Esse é o **token**: ele vai em `DISCORD_BOT_TOKEN`.
     > 🔒 **O token é a senha do bot.** Nunca mande o token em chat, print, e-mail, arquivo ou GitHub. Guarde-o **somente** no Render (passo 3). Se vazar, volte aqui e clique em **Reset Token**: o token antigo para de funcionar na hora.
   - Desligue **Public Bot**, para que só você possa adicionar o bot a servidores.
   - Em **Privileged Gateway Intents**, deixe **as três opções DESLIGADAS** (Presence, Server Members e Message Content). O bot não precisa delas.
   - Deixe **Requires OAuth2 Code Grant** desligado.

## 2. Copiar IDs no Discord (Modo desenvolvedor)

1. No aplicativo do Discord, abra **Configurações de usuário** (engrenagem) → **Avançado**. Ligue o **Modo desenvolvedor**.
2. Para copiar cada ID:
   - **Servidor:** botão direito no ícone do servidor → **Copiar ID do servidor**. Esse ID vai em `DISCORD_GUILD_ID`.
   - **Canal:** botão direito no nome do canal → **Copiar ID do canal**.
   - **Cargo:** Configurações do servidor → **Cargos** → nos três pontinhos do cargo → **Copiar ID do cargo**.
   - **Membro:** botão direito no nome da pessoa → **Copiar ID do usuário**. É isso que você vai colar no **Gerar Prova**.

## 3. Colocar as variáveis no Render (onde o token fica guardado)

1. Entre em **https://dashboard.render.com** e abra o serviço do site.
2. No menu da esquerda, clique em **Environment**.
3. Em **Add Environment Variable**, crie estas quatro:

| Key | Value |
|---|---|
| `DISCORD_ENABLED` | `true` |
| `DISCORD_BOT_TOKEN` | o token do passo 1.4 |
| `DISCORD_CLIENT_ID` | o Application ID do passo 1.2 |
| `DISCORD_GUILD_ID` | o ID do servidor do passo 2 |

4. Clique em **Save Changes**. Se o Render oferecer, escolha **Save, rebuild, and deploy**. O Render reinicia o site sozinho; isso leva alguns minutos.

> O endereço público usado nos links (`https://...onrender.com`) já é informado automaticamente pelo Render. Você não precisa configurar nada para isso.
>
> Versão do Node exigida: **22.x**. Ela já está definida no `package.json`, e o Render usa essa versão automaticamente.

## 4. Convidar o bot e registrar o comando /provatcel

1. No site, entre no painel admin → aba **Discord**.
2. Clique em **➕ Convidar o bot para o servidor**. O Discord abre a tela de convite já no servidor certo, com as permissões necessárias:
   - Ver canais
   - Enviar mensagens
   - Inserir links
   - Ler histórico de mensagens
   - Gerenciar cargos
   - Gerenciar apelidos

   Clique em **Autorizar**.
3. Volte à aba Discord e clique em **Registrar /provatcel no servidor**.
   - Pode clicar quantas vezes quiser: isso nunca apaga comandos de outros bots.
   - (Quem usa terminal pode fazer o mesmo com `npm run discord`.)

## 5. Ajustes no servidor do Discord (hierarquia e permissões)

1. **Posição do cargo do bot.** Vá em Configurações do servidor → **Cargos** e **arraste o cargo do bot para cima** de:
   - os cargos que ele vai adicionar e remover (`1231023397069258844`, `1057349963203498105` e `1057349976482664569`);
   - o cargo mais alto das pessoas que ele vai promover.

   Sem isso, o Discord não deixa o bot trocar cargos e apelidos. A revisão da promoção avisa e **bloqueia antes de começar**.
2. **Canais privados.** Nos canais do painel, de resultados e de promoções, abra Editar canal → **Permissões** → adicione o bot. Permita:
   - Ver canal
   - Enviar mensagens
   - Inserir links
   - Ler histórico de mensagens
3. **Para o anúncio notificar o cargo promovido**, escolha **uma** destas opções:
   - (recomendado) No canal de promoções, dê ao bot a permissão **Mencionar @everyone, @here e todos os cargos**, **só nesse canal**.
   - Ou deixe o cargo `1231023397069258844` como mencionável: Cargos → cargo → **Permitir que todos @mencionem este cargo**.

   Sem nenhuma das duas, o anúncio mostra o cargo, mas não notifica ninguém.
4. **O dono do servidor** não pode ter o apelido trocado por bots. Promova essa pessoa manualmente.

## 6. Configurar na aba Discord do site

1. Preencha:
   - canal do painel;
   - canal de resultados;
   - os três campos de cargos de operador;
   - se quiser, a **prova padrão**.

   Para listas, separe os IDs por vírgula.
2. Clique em **Salvar configuração** e depois em **Verificar no Discord**. O site confere:
   - se canais e cargos existem;
   - as permissões do bot;
   - a posição do cargo do bot.
3. No Discord, **dentro do canal do painel**, digite `/provatcel`. O painel com os 3 botões aparece. Se você rodar de novo, o bot só atualiza o mesmo painel, sem criar outro.

> Se faltar qualquer configuração (canal, cargos), o bot **bloqueia** o uso em vez de liberar para todos.

---

## Como testar sem arriscar ninguém de verdade

1. Crie **cargos de teste** e um **canal de teste** (ou use um servidor de teste).
2. Na aba Discord, troque **temporariamente** os cargos a adicionar/remover e o canal de promoções pelos de teste.
3. Use uma **segunda conta do Discord**, sua ou de alguém da equipe, como "aluno de teste".
4. **Gerar Prova** para essa conta:
   - Abra o link do **aluno** num navegador.
   - Abra o link do **fiscal** num **navegador diferente**, ou numa janela anônima.

   A regra do site é: um navegador = um papel. Não teste aluno e fiscal (nem admin) no mesmo navegador.
5. Confira três coisas:
   - a tela do aluno aparece para o fiscal;
   - o cronômetro corre;
   - as respostas continuam marcadas depois de recarregar a página.

   Finalize e veja o aviso no canal de resultados.
6. **Promover** a conta de teste e conferir cargos, apelido e anúncio.
7. Depois dos testes, **volte os IDs reais** na aba Discord.
   - A conta de teste promovida fica "bloqueada" para uma nova promoção.
   - Para liberar, use **Liberar nova promoção** na aba Discord. Isso não mexe em cargos.

---

## Onde ver se está funcionando (e os erros)

- **Aba Discord do site:**
  - situação do bot (Conectado / Reconectando / Erro) e último erro;
  - fila de envios ao Discord, com o botão **Reprocessar** para tarefas com falha;
  - promoções, com os botões **Retomar pendentes** e **Liberar nova promoção**.
- **Logs do Render:** serviço → **Logs**. Procure por `[discord]` e `[discord-worker]`. Os logs nunca mostram o token nem os links de prova.
- **Aba Segurança & Auditoria do site:** registra, sem nenhum token:
  - tentativas sem permissão (`discord_unauthorized`);
  - salas criadas pelo bot;
  - promoções;
  - edições e exclusões de notas.

## Como desligar ou voltar atrás

- **Desligar o bot sem mexer em mais nada:** no Render, mude `DISCORD_ENABLED` para `false` e salve. O site continua normal.
- **Voltar a versão do site:** no Render, abra o serviço → **Events**, ache um deploy anterior e clique em **Rollback**.
- **Token vazou:** Developer Portal → Bot → **Reset Token**. Depois atualize `DISCORD_BOT_TOKEN` no Render.

---

## Coisas importantes para saber

- **⚠️ Plano gratuito do Render "dorme".** Se ninguém abrir o site por uns 15 minutos, o Render desliga o serviço. O bot desliga junto:
  - os botões do Discord respondem "Esta interação falhou";
  - isso dura até alguém abrir o site de novo, e aí ele acorda em cerca de 1 minuto.

  Nenhuma nota se perde com isso: os avisos pendentes saem quando ele acordar. Para o bot ficar online o tempo todo, o serviço precisa estar num plano pago do Render (ex.: Starter).

- **O vínculo por ID diz para quem a prova foi gerada. Ele não prova quem abriu o link.** Envie o link do aluno só para a pessoa certa. O link do fiscal é de quem gerou a prova: nunca envie ao aluno.
- **Os links não podem ser mostrados de novo**, porque o site guarda só uma "impressão digital" deles, igual senha. Se perder um link, use **Regenerar links**: os links anteriores param de funcionar.
- **Editar ou excluir uma nota não desfaz uma promoção já feita.** O bot não remove cargos sozinho. O site avisa, e você ajusta manualmente se precisar.
- **Nota ajustada:** a nota calculada pelo site continua guardada. A nota ajustada aparece como a nota efetiva, com o registro de quem alterou, quando e por quê.
- **Se o Discord estiver fora do ar**, as notas são salvas normalmente e os avisos ficam na fila. Eles são enviados quando o Discord voltar, inclusive depois de um reinício do site.

---

## Para quem mexe no código (referência técnica)

- **Comandos:**

  | Comando | O que faz |
  |---|---|
  | `npm start` | sobe o site |
  | `npm test` | testes unitários |
  | `npm run test:integration` | testes com MongoDB temporário em memória. Na primeira vez, baixa ~80 MB. Não usa o Discord real. |
  | `npm run discord` | registra o `/provatcel` |

- **Teste local:**
  1. Copie `.env.example` para `.env`.
  2. Preencha `MONGODB_URI` com um banco de **teste** e as variáveis `DISCORD_*` de um **bot/servidor de teste**.
  3. Rode `npm install`, `npm run discord` e `npm start`.
  4. Abra `http://localhost:3000/admin`.
- **Código:** o código do bot fica em `discord/`. Os serviços compartilhados com o painel ficam em `lib/rooms.js`, `lib/results.js` e `lib/outbox.js`.
