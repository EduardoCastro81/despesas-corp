# Publicação em produção

Há dois caminhos. Os dois usam o `Dockerfile` do projeto e dão ao sistema um endereço próprio com HTTPS.

| | Render (mais simples) | Servidor próprio (VPS) |
|---|---|---|
| Quem cuida do servidor | O Render | Você ou sua TI |
| HTTPS | Automático | Automático (Caddy) |
| Custo aproximado | Plano Starter + disco | VPS com 1 vCPU e 1–2 GB de RAM |
| Arquivos usados | `render.yaml` | `docker-compose.yml` |

Antes de começar, separe:
- a **chave da Anthropic** (`ANTHROPIC_API_KEY`), para a leitura automática das notas;
- os **dados do servidor de e-mail** (SMTP);
- o **e-mail e a senha do administrador master** (`MASTER_EMAIL` e `MASTER_PASSWORD`, com no mínimo 8 caracteres, letras e números).

## Opção 1 — Render

1. Crie uma conta em https://render.com e conecte o seu GitHub.
2. Clique em **New → Blueprint** e escolha o repositório `despesas-corp`. O Render lê o `render.yaml` e já cria:
   o serviço web, o disco persistente de 5 GB em `/data` (onde ficam o banco e os comprovantes) e uma `JWT_SECRET`
   aleatória.
3. Preencha as variáveis pedidas:
   - `APP_URL`: o endereço do serviço, por exemplo `https://despesas-corp.onrender.com`, ou o seu domínio;
   - `MASTER_EMAIL` e `MASTER_PASSWORD`;
   - `ANTHROPIC_API_KEY`;
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` e `MAIL_FROM`.
4. Aguarde o deploy e acesse `https://SEU-ENDERECO/admin/`.
5. Domínio próprio (opcional): em **Settings → Custom Domains**, adicione `despesas.suaempresa.com.br`, crie o
   registro DNS indicado e atualize o `APP_URL`.

O disco persistente exige plano pago. Sem ele, os dados seriam apagados a cada atualização.

## Opção 2 — Servidor próprio (VPS) com Docker

Requisitos: um servidor Linux com Docker instalado e um domínio apontando para o IP dele.

```bash
git clone https://github.com/EduardoCastro81/despesas-corp.git
```
```bash
cd despesas-corp && cp .env.example .env && nano .env
```

No `.env`, preencha `DOMINIO`, `APP_URL` (`https://` + domínio), `MASTER_EMAIL`, `MASTER_PASSWORD`,
`ANTHROPIC_API_KEY` e o SMTP. Depois:

```bash
docker compose up -d --build
```

O Caddy obtém o certificado HTTPS sozinho; as portas 80 e 443 precisam estar liberadas. Os backups diários ficam no
volume de dados, em `/data/backups`. Para copiá-los para uma pasta do servidor (e de lá para fora dele):

```bash
docker compose cp app:/data/backups ./backups
```

Para atualizar o sistema depois:

```bash
git pull && docker compose up -d --build
```

## Depois de publicar

1. Entre com o master e troque a senha em **Perfil**.
2. Em **Configurações**, preencha o nome da empresa, envie um **e-mail de teste** e confira se a leitura automática
   aparece como ativa.
3. Cadastre gestores, supervisores e colaboradores (**Usuários e equipes**) e revise as **categorias e limites**.
4. Faça um **backup manual** em Configurações para confirmar que está funcionando.

## Perdi o acesso do administrador master

1. No painel do serviço (Render: **Environment**), adicione a variável `MASTER_RESET_PASSWORD` com uma nova senha (8
   ou mais caracteres, com letras e números). Confira se `MASTER_EMAIL` tem o e-mail que você quer usar no login.
2. Salve. O serviço reinicia e o log mostra `[recuperação] Acesso do master redefinido para ...`.
3. Entre com esse e-mail e a nova senha.
4. Troque a senha em **Perfil** e remova a variável `MASTER_RESET_PASSWORD`. Cada valor da variável é aplicado uma
   única vez, então reinícios não desfazem a troca. Para uma nova recuperação no futuro, use um valor diferente.

Nenhum dado é apagado. Se o e-mail de `MASTER_EMAIL` ainda não existir no sistema, um novo master é criado com ele.
O procedimento também desbloqueia um login bloqueado por tentativas erradas, porque o reinício zera o bloqueio.

## Backup e restauração

- **Automático:** todo dia, a partir de `BACKUP_HOUR` (padrão 2h), o sistema copia o banco e os comprovantes e guarda
  os `BACKUP_KEEP` mais recentes (padrão 14). O destino é `BACKUP_DIR`, por padrão `DATA_DIR/backups`.
- **Manual:** botão em Configurações (somente o master) ou `npm run backup`.
- **Cópia externa:** os backups ficam no mesmo servidor. Copie a pasta de backups periodicamente para outro lugar
  (Google Drive, OneDrive, S3, outro disco). Se o servidor for perdido, só a cópia externa salva os dados.

**Para restaurar:** pare o sistema e substitua `DATA_DIR/despesas.db` e a pasta `DATA_DIR/uploads` pelas versões do
backup escolhido. Copie também o `.jwt-secret`, se não usar `JWT_SECRET`. Apague os arquivos `despesas.db-wal` e
`despesas.db-shm`, se existirem, e inicie o sistema de novo.

## Segurança já incluída

- **Senhas:** mínimo de 8 caracteres, com letras e números. Ficam guardadas com bcrypt.
- **Login:** bloqueio de 15 minutos após 5 tentativas erradas para o mesmo e-mail, ou 20 vindas do mesmo IP.
- **"Esqueci minha senha":** link por e-mail válido por 60 minutos e de uso único. A resposta é a mesma exista ou não
  o e-mail, para não revelar quem tem cadastro.
- **Sessões:** trocar ou redefinir a senha, desativar o usuário ou mudar o perfil dele encerra as sessões abertas.
- **Comprovantes:** carregados por um cookie HttpOnly com SameSite=Strict, que só vale para comprovantes e impressão.
  O código de sessão não aparece em links nem nos logs.
- **Senha padrão:** em produção, sem `MASTER_PASSWORD`, o sistema não usa `admin123`. Ele gera uma senha aleatória e a
  mostra só no log da primeira execução.
- **HTTPS:** com `TRUST_PROXY=1`, os cookies passam a ser `Secure` e o cabeçalho HSTS é enviado.
