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
`MASTER_EMAIL` e `MASTER_PASSWORD`.

Para carregar dados de demonstração (equipe, despesas com comprovantes e prestações em várias etapas):

```bash
npm run seed:demo
```

Os usuários de demonstração usam a senha `demo123`: `gestor@demo.com`, `supervisor@demo.com`, `supervisora@demo.com`,
`carlos@demo.com`, `ana@demo.com`, `bruno@demo.com` e `diana@demo.com`.

Testes automatizados (cobrem perfis, fluxo de aprovação, edição com notificação, adiantamentos e relatórios):

```bash
npm test
```

### Variáveis de ambiente

| Variável | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Ativa a leitura automática dos comprovantes. Sem ela o sistema funciona normalmente, mas o preenchimento é manual |
| `CLAUDE_MODEL` | Modelo usado na leitura (padrão `claude-opus-5-5`) |
| `PORT` | Porta HTTP (padrão 3000) |
| `DATA_DIR` | Pasta do banco e dos comprovantes (padrão `./data`). **Inclua essa pasta no backup** |
| `JWT_SECRET` | Chave das sessões. Se não for definida, é gerada e guardada em `DATA_DIR` |
| `MASTER_EMAIL` / `MASTER_PASSWORD` | Acesso do master criado na primeira execução |

Em produção, coloque o sistema atrás de HTTPS (Nginx, Caddy ou o balanceador da nuvem). A câmera do celular só funciona
em páginas HTTPS.

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
  seed-demo.js        dados de demonstração
public/
  app/                plataforma de lançamento (mobile)
  admin/              plataforma de administração
  shared/             estilos e componentes comuns
test/api.test.js      testes do fluxo completo
```
