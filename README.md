# Despesas Corp — controle e prestação de contas de despesas corporativas

Sistema web com duas plataformas que usam o mesmo servidor e o mesmo banco de dados:

| Plataforma | Endereço | Para quem |
|---|---|---|
| **Lançamento** (celular) | `/app/` | Todos os usuários: fotografar notas, lançar despesas, montar e enviar prestações de contas, pedir adiantamentos |
| **Administração** | `/admin/` | Master, gestor e supervisor: conferência, aprovação, análise, relatórios, auditoria e cadastros |

## Como rodar

Requisitos: Node.js 22.13 ou superior. Não precisa de um servidor de banco de dados separado, porque o SQLite já vem embutido no Node.

```bash
npm install
```

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Abra `http://localhost:3000`. No primeiro acesso o sistema cria o **administrador master**:
`admin@empresa.com` / `admin123`. Troque essa senha no primeiro login. Também dá para definir o acesso inicial com
`MASTER_EMAIL` e `MASTER_PASSWORD`. Em produção (`NODE_ENV=production`) a senha padrão nunca é usada: sem
`MASTER_PASSWORD`, o sistema gera uma senha aleatória e a mostra no log da primeira execução.

**Para publicar online com HTTPS (Render ou servidor próprio), veja o [DEPLOY.md](DEPLOY.md).**

Para carregar dados de demonstração (equipe, despesas com comprovantes e prestações em várias etapas):

```bash
npm run seed:demo
```

Os usuários de demonstração usam a senha `demo123`: `gestor@demo.com`, `supervisor@demo.com`, `supervisora@demo.com`,
`carlos@demo.com`, `ana@demo.com`, `bruno@demo.com` e `diana@demo.com`.

Testes automatizados (cobrem perfis, fluxo de aprovação, edição com notificação, adiantamentos, relatórios, avisos por e-mail, segurança e backup):

```bash
npm test
```

### Variáveis de ambiente

As variáveis podem ser definidas no ambiente do servidor ou num arquivo `.env` na pasta do sistema (copie de
`.env.example`). O arquivo `.env` não é enviado ao GitHub.

| Variável | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Ativa a leitura automática dos comprovantes. Sem ela o sistema funciona normalmente, mas o preenchimento é manual |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Servidor de e-mail para os avisos. Sem `SMTP_HOST` os avisos aparecem só dentro do sistema |
| `SMTP_SECURE` | `true` para SSL direto (porta 465). Padrão: automático pela porta |
| `MAIL_FROM` | Remetente dos e-mails, ex.: `Despesas <despesas@suaempresa.com.br>` |
| `APP_URL` | Endereço público do sistema, usado nos links dos e-mails |
| `CLAUDE_MODEL` | Modelo usado na leitura (padrão `claude-opus-5-5`) |
| `PORT` | Porta HTTP (padrão 3000) |
| `DATA_DIR` | Pasta do banco e dos comprovantes (padrão `./data`). **Inclua essa pasta no backup** |
| `JWT_SECRET` | Chave das sessões. Se não for definida, é gerada e guardada em `DATA_DIR` |
| `MASTER_EMAIL` / `MASTER_PASSWORD` | Acesso do master criado na primeira execução |
| `TRUST_PROXY` | `1` quando o sistema roda atrás de um proxy HTTPS (Render, Caddy, Nginx) |
| `BACKUP_HOUR`, `BACKUP_KEEP`, `BACKUP_DIR` | Backup diário: horário (padrão 2), quantos manter (padrão 14) e pasta (padrão `DATA_DIR/backups`). `BACKUP_ENABLED=0` desliga |

Em produção, coloque o sistema atrás de HTTPS (veja o [DEPLOY.md](DEPLOY.md)).

## Perfis e permissões

| Perfil | O que faz |
|---|---|
| **Administrador master** | Acesso total. Cadastra gestores e outros masters. Pode editar qualquer lançamento, inclusive de prestações finalizadas |
| **Gestor** | Cadastra supervisores, colaboradores, categorias e regras. Gerencia todos os lançamentos (pode lançar em nome de outra pessoa, editar e excluir). Dá a aprovação final, registra pagamentos e adiantamentos e **recebe a notificação de toda edição** |
| **Supervisor** | Vê só o próprio time. Confere e aprova (1º nível), devolve ou rejeita prestações e glosa itens. **Edita apenas os campos liberados** em Configurações e só antes da aprovação do gestor, sempre com justificativa obrigatória |
| **Colaborador** | Lança as próprias despesas e prestações. Só altera o que está em rascunho ou foi devolvido para ajuste |

### Notificação de edições (antes e depois)

Toda edição de lançamento gera um registro na **Auditoria de edições** e uma notificação para os gestores (se não
houver gestor ativo, os masters recebem). A notificação traz cada campo alterado com o valor **antes → depois**, quem
editou, o perfil e a justificativa. O dono da despesa também é avisado quando outra pessoa edita o lançamento dele. O
mesmo vale para glosas, exclusões e inclusão ou remoção de comprovantes. Em Configurações dá para desligar a
notificação das edições que o colaborador faz nos próprios rascunhos.

### Avisos por e-mail

Com o SMTP configurado, os avisos do sistema também chegam por e-mail, com um botão que abre o item direto na
plataforma certa: administração para master, gestor e supervisor, lançamento para o colaborador. O e-mail de edição
traz a tabela de **antes → depois** e a justificativa.

- Em **Configurações**, o gestor liga ou desliga o envio, escolhe os tipos de aviso enviados (edições, exclusões,
  aprovações pendentes, mudança de situação da prestação, glosas, adiantamentos), envia um e-mail de teste e consulta o
  **histórico de envios**.
- **Lembrete diário** (horário configurável): cada supervisor recebe a lista das prestações do seu time que aguardam
  aprovação, e os gestores recebem as que aguardam aprovação final ou pagamento.
- Cada usuário pode deixar de receber e-mails no próprio **Perfil**. O gestor também pode ajustar isso no cadastro do
  usuário.
- Os e-mails são enviados em segundo plano. Se o servidor de e-mail falhar, o sistema tenta de novo automaticamente
  (até 5 vezes, em intervalos crescentes) e a falha aparece no histórico, com opção de reenviar.

Exemplos de SMTP: Google Workspace/Gmail usa `smtp.gmail.com`, porta 587, com uma "senha de app". Microsoft 365 usa
`smtp.office365.com`, porta 587.

### Acesso e senhas

- **Esqueci minha senha:** na tela de login, o usuário recebe por e-mail um link válido por 1 hora para criar uma nova
  senha. Isso exige o SMTP configurado; sem ele, o gestor redefine a senha no cadastro do usuário.
- **Senhas:** mínimo de 8 caracteres, com letras e números.
- **Login:** bloqueado por 15 minutos após 5 tentativas erradas.
- **Sessões:** trocar a senha, desativar um usuário ou mudar o perfil dele encerra as sessões abertas.

## Rotina de aprovação da prestação de contas

```
Rascunho ─► Aguardando supervisor ─► Aguardando gestor ─► Aprovada ─► Finalizada (paga/liquidada)
              │  (glosa item a item)      │                   
              └──► Devolvida p/ ajuste ◄──┘ ──► colaborador corrige e reenvia
              └──► Rejeitada ◄────────────┘
```

- Se o colaborador não tiver supervisor, a prestação vai direto para o gestor.
- **Alçada do supervisor** (Configurações): prestações até o valor definido são aprovadas em definitivo pelo supervisor.
- No envio, o sistema avisa quando há despesa sem comprovante em categoria que exige comprovante.
- Na finalização, o sistema calcula o **saldo**: total aprovado − adiantamento = valor a reembolsar ao colaborador ou
  a devolver por ele. O adiantamento vinculado passa a "liquidado".
- Cada etapa fica no histórico com data, responsável e comentário, e notifica o próximo aprovador e o colaborador.
- A prestação pode ser impressa ou salva em PDF com despesas, totais, histórico, campos de assinatura e os comprovantes.

## Leitura automática dos comprovantes

Na plataforma de lançamento, o botão **Fotografar** abre a câmera do celular. **Enviar arquivo** aceita JPG, PNG, WEBP
ou PDF. A primeira imagem é enviada ao Claude (Anthropic), que identifica o tipo de documento (NF-e, NFC-e/cupom
fiscal, NFS-e ou recibo/nota de despesa) e preenche data, valor total, fornecedor, CNPJ/CPF, número, chave de acesso,
cidade, forma de pagamento (quando impressa), categoria sugerida e descrição. Os campos preenchidos ficam destacados
para conferência, e avisos como "ilegível" ou "sem CNPJ" aparecem na tela. Os dados lidos ficam guardados junto com a
despesa. As imagens são reduzidas no próprio celular antes do envio.

## Conferência e análise (administração)

- **Filtros**: período, usuário, equipe do supervisor, categoria, forma de pagamento, com ou sem adiantamento,
  situação, tipo de documento, alertas, despesas editadas e busca livre.
- **Visualizador de comprovantes** com zoom, rotação, download e PDF embutido.
- **Alertas automáticos**: valor acima do limite da categoria, possível duplicidade (mesma chave de acesso, mesmo
  número, CNPJ e valor, ou mesma data, valor e fornecedor), despesa sem comprovante e despesa editada.
- **Exportação** para CSV e Excel com os filtros aplicados.

### Relatórios gerenciais

Painel com indicadores e evolução mensal, e relatórios consolidados por categoria, usuário, mês, forma de pagamento,
com ou sem adiantamento, centro de custo, tipo de documento, situação e principais fornecedores. Também há a
**matriz usuário × categoria**, o **saldo de adiantamentos** por colaborador e os **prazos médios de aprovação**
(envio → supervisor → aprovação final → pagamento).

## Estrutura

```
server/
  index.js            servidor Express
  db.js               esquema SQLite, configurações e dados iniciais
  common.js           perfis, autenticação, escopo de visibilidade
  routes/users.js     login, usuários, categorias, configurações, notificações
  routes/expenses.js  despesas, filtros, edição auditada, glosa, comprovantes, exportação, auditoria
  routes/reports.js   prestações, rotina de aprovação, impressão, adiantamentos
  routes/analytics.js relatórios gerenciais
  services/ocr.js     leitura automática de comprovantes (Claude)
  services/notify.js  notificações e cálculo do antes/depois
  services/email.js   avisos por e-mail: fila, envio SMTP, novas tentativas, lembrete diário, redefinição de senha
  services/ratelimit.js  bloqueio de tentativas de login e de redefinição de senha
  services/backup.js  backup diário do banco e dos comprovantes, com retenção
  backup-cli.js       npm run backup
  seed-demo.js        dados de demonstração
public/
  app/                plataforma de lançamento (mobile)
  admin/              plataforma de administração
  shared/             estilos e componentes comuns
test/api.test.js      testes do fluxo completo
test/email.test.js    testes dos avisos por e-mail (com servidor SMTP de teste)
test/security.test.js testes de senha, bloqueio de login, sessões e redefinição de senha
Dockerfile, docker-compose.yml, render.yaml   publicação (ver DEPLOY.md)
```
