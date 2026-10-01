# Armazenamento do MongoDB: quadro do cluster e limpeza segura

Fica no painel em **Segurança & Auditoria**. Só o **administrador principal** vê e usa. Uma conta restrita não vê a aba, e o servidor responde 403, sem nenhum dado, a qualquer chamada da API dessas rotas.

## 1. Quadro "Armazenamento do cluster (MongoDB Atlas)"

O quadro mede o **cluster inteiro**: todos os bancos, inclusive os de outros projetos no mesmo cluster.

- **Como é medido:** pelo comando oficial `atlasSize` ([documentação](https://www.mongodb.com/docs/atlas/free-tier-commands/)). O valor `atlasSize` é a soma de dados e índices de todos os bancos, que é o que conta para o limite de 512 MB do plano gratuito.
- **O que mostra:**
  - consumo total;
  - limite do plano;
  - % utilizado;
  - espaço restante;
  - barra de utilização;
  - número de bancos;
  - horário da última consulta, no horário de Brasília.
- **Situação:**

  | Faixa | Situação |
  |---|---|
  | abaixo de 70% | Normal |
  | a partir de 70% | Atenção |
  | a partir de 85% | Alto |
  | a partir de 95% | Crítico |

- **Unidade:** MB de 1.048.576 bytes. Consumo e limite usam a mesma base, e as contas são feitas em bytes.
- **Atualização:**
  - a consulta fica em cache por 5 minutos;
  - o botão **"Atualizar armazenamento"** força uma consulta nova, no máximo uma a cada 30 segundos;
  - o quadro se atualiza sozinho depois de uma limpeza.
- **Limite:** padrão de 512 MB. Pode ser mudado pela variável `ATLAS_STORAGE_LIMIT_MB` no Render, só se você trocar de plano.

### Se aparecer "Não foi possível consultar o consumo total"

O quadro **não mostra número nenhum** nesse caso: nem zero, nem o tamanho só deste site. Abaixo da mensagem aparece um código, como `Unauthorized` ou `CommandNotFound`.

Verifique:

1. **O tipo do cluster.** O `atlasSize` só existe em clusters **Free (M0)** e **Flex**. Num cluster pago (M10 ou maior), veja o uso em Atlas → seu cluster → **Metrics**.
2. **A permissão do usuário.** Abra Atlas → **Database Access** → o usuário que está no `MONGODB_URI` do Render. A documentação do Atlas não diz qual privilégio o comando exige; se aparecer `Unauthorized`, dê a esse usuário o papel **"Atlas admin"** ou **"Read and write to any database"**.
3. **A consulta de novo.** Depois de mudar algo no Atlas, clique em **"Atualizar armazenamento"**.

O quadro **não precisa de nenhuma variável nova** além do `MONGODB_URI`, que já existe.

## 2. "Limpar armazenamento": o que pode e o que nunca é apagado

A limpeza atua **somente no banco deste site** (a conexão do `MONGODB_URI`). Ela usa uma lista fixa de categorias: nunca usa `dropDatabase`, nunca apaga coleções inteiras e nunca escolhe coleções por nome parecido.

### Elegíveis

A data precisa ser **anterior** à data de corte. Um registro exatamente na data de corte fica.

| Categoria | Coleção | Data usada | Condições extras |
|---|---|---|---|
| Notas/resultados e tentativas (as respostas estão dentro da tentativa) | `examattempts` | `finishedAt` (conclusão) | Só tentativas finalizadas. Não pode estar em promoção, ter aviso do BotGhost pendente ou ter devolução de Role DAFP não confirmada. A sala dela também precisa sair (ou já não existir). |
| Avisos do BotGhost dessas tentativas | `integrationnotifications` | saem junto com a tentativa apagada | Só os tipos `result`, `dafp_started` e `dafp_base_restore`, e só os já concluídos (`delivered`, `failed` ou `cancelled`). |
| Salas finalizadas ou encerradas | `rooms` | `endedAt`; em salas antigas, `updatedAt`, que nunca é anterior ao encerramento | Só sai se todas as tentativas dela também saírem. Nunca sai sala com alguém conectado. |
| Salas abandonadas (link nunca usado) | `rooms` | `updatedAt` | Status "aguardando", sem tentativa, sem ninguém conectado. |
| Eventos das provas (logs de fiscalização) | `examevents` | `at` | Só se a tentativa e a sala do evento também saírem (ou já não existirem). |
| Logs de segurança e auditoria | `securitylogs` | `at` | Menos os registros das próprias limpezas (`storage_cleanup_*`). |

### Nunca apagados

- **Coleções inteiras que a limpeza não toca:**
  - `exams` (provas, regras, pontuação, critérios de aprovação);
  - `questions` (questões, alternativas, gabaritos);
  - `settings` (visual, imagens, vídeos);
  - `messagetemplates` (templates, embeds e mensagens do bot);
  - `users` (logins, senhas, perfis);
  - `integrationconfigs` (configurações e credenciais do BotGhost, painel do Discord);
  - `promotions` e `promotiondrafts`;
  - `integrationrequests` (já se limpa sozinha em 7 dias);
  - `sessions` (expira sozinha);
  - `storagecleanups` (histórico das limpezas);
  - `historycounters` (totais acumulados);
  - **qualquer outro banco do cluster**.
- **Mesmo velhos, ficam:**
  - provas em andamento e salas ativas;
  - tentativas sem data de conclusão;
  - tentativas usadas em promoções (evita promover de novo e mantém o histórico);
  - avisos pendentes, reservados, ambíguos ou aguardando edição, e a tentativa deles;
  - provas DAFP com a Role base ainda não devolvida;
  - salas com alguém conectado;
  - eventos de tentativas ou salas mantidas.

### Discord e totais

- **Mensagens já publicadas no Discord:** continuam lá, com os botões. O "VERIFICAR NOTA" é 100% BotGhost. Resultados mantidos continuam editáveis, porque o aviso deles não é apagado.
- **Rankings:** este site não tem ranking.
- **Total de "Provas finalizadas" do Dashboard:** era calculado contando as tentativas. Agora a limpeza soma as que apagou num contador acumulado (`historycounters`), então o total **não diminui**.

## 3. Passo a passo no painel

1. Entre com o **login principal**.
2. Clique em **Segurança & Auditoria** e veja o quadro do cluster.
3. Clique em **"Limpar armazenamento"**. Abre uma janela que avisa que a exclusão é permanente.
4. Escolha **"Mais de 3 meses"** (90 dias), **"Mais de 2 meses"** (60 dias) ou **"Mais de 1 mês"** (30 dias). O site faz uma **simulação**, sem apagar nada, e mostra:
   - período e data de corte (fixada pelo servidor naquele momento);
   - quantos registros de cada categoria seriam apagados;
   - quantos foram **preservados** e por quê;
   - o espaço estimado. É só uma **estimativa** dos dados, sem índices: o Atlas pode não reduzir na mesma proporção nem na hora.
5. Confira os números e escolha:
   - **"Cancelar"**: nada acontece;
   - **"Confirmar limpeza"**: confirme a pergunta final.
6. A prévia vale **10 minutos** e só para quem a gerou. Se passar disso, gere outra.
7. A limpeza roda em lotes e mostra o progresso. Pode fechar a janela, que ela continua; ao voltar à aba, o andamento aparece de novo.
8. No fim aparece:
   - quantos registros foram **realmente** apagados por categoria;
   - os preservados, inclusive o que ganhou pendência entre a prévia e a execução;
   - eventuais falhas.

   O quadro do cluster é consultado de novo. Fica registrada uma entrada `storage_cleanup_executed` nos Logs de segurança, com administrador, período, data de corte e resultado. Essa entrada nunca é apagada por limpezas.

Só uma limpeza roda por vez. Se o site reiniciar no meio, ela aparece como "interrompida": o que já foi apagado continua apagado, e o resto fica como estava.
