# Checklist de teste e ativação — integração BotGhost

Faça **na ordem**. Primeiro tudo com **membro, cargos e canais de TESTE**. Só no fim troque para os valores reais.

## A. Antes de começar
- [ ] Um comando **antigo** do BotGhost funciona normalmente (anote qual testou).
- [ ] Criado um **canal de teste**, por exemplo `#tcel-teste`, visível só para a equipe.
- [ ] Criados **cargos de teste**, por exemplo `Teste-Promovido`, `Teste-TCEL` e `Teste-Recruta`. Eles precisam ficar **abaixo** do cargo do bot na lista de cargos.
- [ ] Um **membro de teste** (uma segunda conta sua) com o cargo `Teste-Recruta`.
- [ ] O bot do BotGhost tem, no servidor, as permissões **Gerenciar Cargos**, **Gerenciar Apelidos**, **Enviar Mensagens** e **Inserir Links** nos canais usados.

## B. Site (aba Integração BotGhost)
- [ ] Deploy feito fora de horário de prova (RENDER-GRATUITO.md).
- [ ] "Integração: Ligada", chave "✓ definida", servidor autorizado correto.
- [ ] Operadores: **só o seu ID** por enquanto, nas três ações.
- [ ] Canal de resultados = **canal de teste**; canal de TESTE = canal de teste.
- [ ] Promoção com os **cargos de teste**: adicionar `Teste-Promovido, Teste-TCEL`, remover `Teste-Recruta`. Anúncio no **canal de teste**, cargo do anúncio = `Teste-Promovido`.
- [ ] Anote em algum lugar os valores reais: adicionar `1231023397069258844, 1057349963203498105`, remover `1057349976482664569`, canal `1396947587235578017`.

## C. BotGhost (BOTGHOST-MONTAGEM.md)
- [ ] 0.2: `/health` com **Test Request** → `"ok": true`.
- [ ] Parte A: `/provatcel` publica o painel com 3 botões, e a aba Integração mostra "Painel registrado".
- [ ] Um usuário **fora** da lista de operadores recebe "não autorizado".
- [ ] Parte B:
  - [ ] Gerar Prova para o membro de teste: os links aparecem **só para você**.
  - [ ] Clicar de novo para o mesmo membro: "sala já aberta" + Regenerar. Após regenerar, o link antigo não abre mais.
  - [ ] O link do aluno abre a prova. O link de fiscal abre a tela do fiscal.
- [ ] Faça a prova com o membro de teste até o fim.
- [ ] Parte C: Conferir resultados mostra a nota; Anterior/Próxima/Atualizar funcionam.
- [ ] Parte E (se o Webhooks existir no seu plano): `BOTGHOST_NOTIFICATIONS_ENABLED=true` no Render.
  - [ ] Na aba **Mensagens do Bot**, **Enviar teste** de "Resultado concluído" → a mensagem aparece no canal de teste e a fila mostra "Entregue".
  - [ ] Nova prova finalizada → "Prova finalizada: @membro — Nota: X / Y — Prova: …" no canal de teste.
  - [ ] Editar a nota no admin → a **mesma** mensagem é editada (sem novo ping).
  - [ ] Excluir o resultado → a mensagem vira "removido".
- [ ] Parte D, com os **cargos de teste**:
  - [ ] Selecionar → preencher RP (teste um nome longo: o bot pede para encurtar; teste um ID `007`: os zeros ficam) → revisar → confirmar → executar.
  - [ ] O membro de teste recebe os cargos de teste, perde `Teste-Recruta` e fica com o apelido `『TCEL•B』NOME | ID`.
  - [ ] Publicar anúncio → "Parabéns aos promovidos para @Teste-Promovido" e uma menção por linha.
  - [ ] Promover o mesmo membro de novo → bloqueado ("já promovido").
  - [ ] Suba temporariamente `Teste-TCEL` **acima** do bot e promova outro membro de teste → "parcial" com erro. Desça o cargo, clique "Retomar pendentes" no admin e depois "Executar" → concluído, sem repetir o anúncio de quem já foi anunciado.
- [ ] Anote aqui as **pendências de validação** que funcionaram ou não (fim do BOTGHOST-MONTAGEM.md).

## D. Ativação real (só depois de tudo acima)
- [ ] Aba Integração: operadores reais, canal de resultados real e **cargos/canal reais** de promoção (os valores anotados em B).
- [ ] O cargo do anúncio precisa ser mencionável, ou o bot precisa da permissão de mencionar cargos, para o ping funcionar.
- [ ] O cargo do bot fica **acima** de `1231023397069258844`, `1057349963203498105` e `1057349976482664569`.
- [ ] **Não** teste promoção em membro real sem necessidade: a primeira promoção real é a de verdade.
- [ ] Confira de novo o comando antigo do BotGhost (anotado em A).
- [ ] Apague os cargos/canal de teste, se quiser (isso não afeta o site).

## E. Limpeza do comando da versão anterior (SEPARADO, manual)
A versão anterior desta integração, com um bot próprio do site, **nunca foi publicada no site**: ficou só na branch de revisão. Se mesmo assim você chegou a seguir o antigo `DISCORD-SETUP.md`:
- **Se** criou um aplicativo novo no Discord Developer Portal **e** registrou `/provatcel` por ele, aparecerão dois `/provatcel` no servidor. Remova o do aplicativo antigo **manualmente**:
  - Servidor → **Configurações do servidor → Integrações** → escolha **o aplicativo antigo** (não o do BotGhost!) → **Remover do servidor**; ou
  - no Developer Portal, apague **aquele aplicativo** (Settings → General → Delete App).
- **Não** mexa no aplicativo do BotGhost, nos comandos dele nem no Interactions Endpoint URL.
- Nada disso é feito automaticamente pelo site. O site não tem mais código para registrar ou apagar comandos.
