# Acessos ao painel: administrador principal e restrito

| | Administrador principal | Administrador restrito |
|---|---|---|
| Dashboard, Provas & Questões, Salas, Central de Monitoramento, Resultados | ✅ | ✅ |
| Logins/senhas | ✅ | ❌ |
| Segurança & Auditoria (inclui armazenamento e limpeza) | ✅ | ❌ |
| Integração BotGhost | ✅ | ❌ |
| Mensagens do Bot | ✅ | ❌ |

## Como os perfis funcionam

- **Seu login atual continua como administrador principal.** As contas que existiam antes desta atualização viram principais sozinhas, ao iniciar o site.
- **Todo acesso criado em "Logins/senhas" é restrito.** Não existe opção para criar outro principal nem para mudar o perfil.
- **O administrador principal não pode ser editado, desativado nem ter a senha trocada por essa tela.** Assim o site nunca fica sem um principal ativo.
- **O bloqueio é feito no servidor.** O perfil é lido da conta gravada no banco a cada pedido. Mesmo digitando o endereço ou chamando a API à mão, a conta restrita recebe "Acesso negado" (403) sem dados.
- **As senhas são guardadas só como hash (argon2id)** e nunca voltam em nenhuma resposta.
- **Desativar uma conta ou redefinir a senha dela** encerra na hora as sessões abertas dessa pessoa, inclusive a atualização em tempo real.

## Criar o primeiro acesso restrito

1. Entre no painel com o seu login (principal).
2. Clique na aba **Logins/senhas**.
3. Em **"Criar acesso restrito"**, preencha:
   - **Nome da pessoa**, por exemplo `Fulano de Tal`;
   - **Login**: de 3 a 40 caracteres, só letras, números, ponto, hífen ou sublinhado, sem espaço. Por exemplo `fulano.tal`;
   - **Senha**: no mínimo 8 caracteres.
4. Clique em **"Criar acesso"**. A pessoa aparece em **"Acessos cadastrados"** como **Restrito · Ativo**.
5. Passe o login e a senha para a pessoa por um canal privado.

## Testar as restrições

1. Abra uma **janela anônima** (ou outro navegador) em `https://SEU-SITE/admin`. A tela de login mostra **"Provas DAFP"**.
2. Entre com o login e a senha criados.
3. **Menu:** devem aparecer só Dashboard, Provas & Questões, Salas, Central de Monitoramento e Resultados. No topo aparece "· acesso restrito".
4. **Acesso direto:** na mesma janela, abra `https://SEU-SITE/api/admin/integration/status`. Deve aparecer `"Acesso negado: esta área é exclusiva do administrador principal."`
5. **Funções permitidas:** abra uma prova, veja Resultados e crie uma sala de teste. Tudo deve funcionar normalmente.
6. **Desativar:** na sua janela (principal), em **Logins/senhas**, clique em **"Desativar"** na linha da pessoa.
   - Na janela anônima, ao clicar em qualquer aba, o painel volta para o login.
   - Tentar entrar de novo mostra "Este acesso está desativado".
7. **Reativar:** clique em **"Ativar"**. A pessoa volta a conseguir entrar.
8. **Redefinir senha:** use **"Redefinir senha"**, digite a nova senha duas vezes e clique em **"Redefinir senha"**. A sessão aberta cai e só a senha nova funciona.

**Não exige nenhuma alteração no BotGhost** nem variável nova no Render.
