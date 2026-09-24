# Render gratuito + integração BotGhost

O site continua no **mesmo serviço web gratuito do Render**: sem worker pago, sem serviço extra e sem "ping" para mantê-lo acordado. Tudo o que importa fica no **MongoDB** (fila de avisos, rascunhos, lotes, promoções, modelos de mensagem). Por isso, dormir ou reiniciar não perde nada.

## Como o plano gratuito afeta o bot

- O Render **desliga o site depois de ~15 minutos sem visitas**. A primeira visita depois disso demora (pode passar de 1 minuto) para ele "acordar".
- Com o site dormindo, os botões do Discord mostram a mensagem local do BotGhost: **"Site iniciando. Abra o site, aguarde e tente novamente."**
- **Rotina recomendada no dia de uso:** abra o site no navegador (qualquer página, por exemplo `/admin`), espere carregar e só então use o `/provatcel`.
- Os avisos (prova finalizada, anúncio) só são disparados **enquanto o site está acordado**. Os que ficarem pendentes são retomados sozinhos quando ele acordar. Nada se perde.
- **Faça deploy e mude variáveis só fora de horário de prova.** Cada deploy reinicia o site e quem estiver fazendo prova naquele momento sofre uma interrupção.

## Passo a passo

### 1. Publicar o código
O Render faz deploy do repositório `ptktoussaint/provas`, branch **`main`**. Esta mudança está na branch de revisão `claude/ups-fluxo-site-memory-abn954`: **só vai para o site depois que você autorizar juntar na `main`.**

Com a integração desligada (padrão), o site funciona exatamente como antes.

### 2. Gerar a chave do site
No painel admin → aba **Integração BotGhost** → **Gerar chave** → **Copiar**. A chave é gerada no seu navegador; o site não recebe nem guarda.

Quem tem terminal também pode gerar com:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Cole a **mesma** chave em dois lugares:
- Render → seu serviço → **Environment** → `BOTGHOST_SITE_API_KEY`
- BotGhost → **Manage Secrets** → `TCEL_SITE_KEY`

Nunca em chat, print, arquivo ou Git.

### 3. Variáveis no Render
Render → seu serviço → **Environment** → **Add Environment Variable**:

| Nome | Valor | Observação |
|---|---|---|
| `BOTGHOST_INTEGRATION_ENABLED` | `true` | `false` desliga tudo na hora (a API responde "desligada") |
| `BOTGHOST_SITE_API_KEY` | a chave do passo 2 | mínimo 32 caracteres; sem ela a API fica fechada |
| `BOTGHOST_ALLOWED_GUILD_ID` | ID do servidor TCEL | só pedidos desse servidor são aceitos |
| `BOTGHOST_NOTIFICATIONS_ENABLED` | `false` por enquanto | vire `true` depois de montar o evento de webhook (Parte E do BOTGHOST-MONTAGEM.md) |
| `BOTGHOST_WEBHOOK_URL` | URL do evento no módulo Webhooks | formato `https://api.botghost.com/webhook/<bot>/<evento>` |
| `BOTGHOST_WEBHOOK_API_KEY` | API Key do módulo Webhooks | **não** é o token do Discord |

- **Não crie** variável com o token do bot. O site não usa e não deve ter.
- As variáveis que já existem (`MONGODB_URI`, `SESSION_SECRET`, `COOKIE_SECURE`, TURN, etc.) continuam iguais.
- A URL pública dos links vem sozinha do Render (`RENDER_EXTERNAL_URL`).

Clique em **Save Changes**. O Render reinicia o serviço sozinho; faça isso fora de horário de prova.

### 4. Conferir
1. Abra `https://SEU-SITE.onrender.com/admin` → aba **Integração BotGhost**. Deve aparecer "Integração: Ligada", "Chave do site: ✓ definida" e o servidor autorizado.
2. Preencha na mesma aba: operadores autorizados (IDs de usuário), canais (resultados e teste) e prova padrão. Clique em **Salvar configuração**.
3. No BotGhost, faça o teste do `/health` (BOTGHOST-MONTAGEM.md, passo 0.2).
4. Volte à aba e clique **Atualizar**: "Último pedido autenticado do BotGhost" deve mostrar a hora do teste.

## Se algo der errado

- **Desligar a integração na hora:** `BOTGHOST_INTEGRATION_ENABLED=false` → Save. As provas continuam funcionando normalmente.
- **Trocar a chave** (vazou ou por precaução): gere outra e atualize **nos dois lugares** (Render e Manage Secrets). A antiga para de valer quando o Render reiniciar.
- **Avisos acumulando com erro 401/404:** a URL ou a API Key do webhook está errada, ou o evento foi apagado no BotGhost. Corrija no Render. Na aba Integração, use "Reprocessar agora" nos avisos com falha.
- **Voltar o código antigo:** Render → **Deploys** → escolher o deploy anterior → **Rollback**. O banco não precisa de nada: as coleções novas (`integrationconfigs`, `integrationnotifications`, `integrationrequests`, `messagetemplates`) são só adicionadas. Nada existente foi apagado ou alterado.
