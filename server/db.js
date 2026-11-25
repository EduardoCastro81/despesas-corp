'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'despesas.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('master','gestor','supervisor','colaborador')),
  supervisor_id INTEGER REFERENCES users(id),
  cost_center TEXT,
  department TEXT,
  cpf TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_cents INTEGER,
  requires_receipt INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  expected_date TEXT,
  status TEXT NOT NULL DEFAULT 'solicitado'
    CHECK (status IN ('solicitado','aprovado','pago','rejeitado','liquidado')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  paid_at TEXT,
  payment_method TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  advance_id INTEGER REFERENCES advances(id),
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho','aguardando_supervisor','aguardando_gestor','devolvida','aprovada','rejeitada','finalizada')),
  submitted_at TEXT,
  supervisor_approved_by INTEGER REFERENCES users(id),
  supervisor_approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  settlement_note TEXT,
  last_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS report_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  advance_id INTEGER REFERENCES advances(id),
  category_id INTEGER REFERENCES categories(id),
  expense_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  access_key TEXT,
  supplier_name TEXT,
  supplier_doc TEXT,
  description TEXT,
  city TEXT,
  cost_center TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho','em_analise','aprovada','glosada')),
  glosa_reason TEXT,
  ocr_data TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_exp_user ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_exp_report ON expenses(report_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  size INTEGER,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS expense_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL,
  editor_id INTEGER NOT NULL REFERENCES users(id),
  editor_role TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'edicao',
  changes TEXT NOT NULL,
  before_data TEXT,
  after_data TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  data TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','erro')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migrações de colunas adicionadas após a primeira versão
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

const DEFAULT_SETTINGS = {
  company_name: 'Minha Empresa',
  // Alçada do supervisor: prestações até este valor (centavos) são aprovadas em definitivo
  // pelo supervisor. 0 = sempre exige aprovação do gestor.
  supervisor_approval_limit_cents: '0',
  // Campos que o supervisor pode editar nos lançamentos do seu time
  supervisor_editable_fields: JSON.stringify(['category_id', 'cost_center', 'description', 'payment_method', 'doc_type', 'city']),
  // Notificar o gestor também quando o próprio colaborador edita um lançamento em rascunho
  notify_owner_draft_edits: '1',
  // Dias máximos entre a data da despesa e o lançamento (0 = sem limite)
  max_days_to_submit: '60',
  // Avisos por e-mail (exigem SMTP configurado no servidor)
  email_enabled: '1',
  // Tipos de aviso enviados por e-mail
  email_types: JSON.stringify(['edicao_despesa', 'exclusao_despesa', 'aprovacao_pendente', 'aprovada_alcada', 'prestacao_status', 'glosa', 'adiantamento', 'despesa_lancada']),
  // Hora (0-23) do lembrete diário de aprovações pendentes; vazio = desativado
  reminder_hour: '8',
  reminder_last_date: '',
};

function getSetting(key) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : DEFAULT_SETTINGS[key];
}
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

// Seed inicial: administrador master e categorias padrão
function seedBase() {
  const c = one('SELECT COUNT(*) n FROM users').n;
  if (c === 0) {
    const email = process.env.MASTER_EMAIL || 'admin@empresa.com';
    // Em produção nunca usa a senha padrão: sem MASTER_PASSWORD, gera uma aleatória e mostra só no log
    const pass = process.env.MASTER_PASSWORD
      || (process.env.NODE_ENV === 'production' ? require('crypto').randomBytes(9).toString('base64url') + '7a' : 'admin123');
    run(`INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?, 'master')`,
      'Administrador Master', email, bcrypt.hashSync(pass, 10));
    console.log(`[seed] Usuário master criado: ${email} / ${pass} (altere a senha após o primeiro acesso)`);
  }
  if (one('SELECT COUNT(*) n FROM categories').n === 0) {
    const cats = [
      ['Alimentação', 15000], ['Hospedagem', 60000], ['Transporte (táxi/app)', 20000],
      ['Combustível', 50000], ['Pedágio', null], ['Estacionamento', 10000],
      ['Passagem aérea/rodoviária', null], ['Material de escritório', 30000],
      ['Representação/clientes', 50000], ['Telefonia/internet', 20000], ['Outros', null],
    ];
    for (const [n, l] of cats) run('INSERT INTO categories(name, limit_cents) VALUES(?, ?)', n, l);
  }
}
seedBase();

// Recuperação de acesso: com MASTER_RESET_PASSWORD definida, a cada inicialização a senha do master
// (MASTER_EMAIL, ou o primeiro master existente) é redefinida, o usuário é reativado e as sessões são
// encerradas. Se MASTER_EMAIL não existir, um novo master é criado. Remova a variável após entrar.
function recoverMaster() {
  const pass = process.env.MASTER_RESET_PASSWORD;
  if (!pass) return;
  if (pass.length < 8 || !/[A-Za-z]/.test(pass) || !/\d/.test(pass)) {
    console.error('[recuperação] MASTER_RESET_PASSWORD ignorada: use ao menos 8 caracteres, com letras e números.');
    return;
  }
  const hash = bcrypt.hashSync(pass, 10);
  const wanted = (process.env.MASTER_EMAIL || '').trim();
  let u = wanted ? one('SELECT id, email FROM users WHERE email = ?', wanted)
    : one(`SELECT id, email FROM users WHERE role = 'master' ORDER BY id LIMIT 1`);
  if (u) {
    run(`UPDATE users SET password_hash = ?, role = 'master', active = 1, token_version = token_version + 1 WHERE id = ?`, hash, u.id);
  } else {
    const email = wanted || 'admin@empresa.com';
    run(`INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?, 'master')`, 'Administrador Master', email, hash);
    u = { email };
  }
  console.log(`[recuperação] Acesso do master redefinido para ${u.email}. Entre com a senha de MASTER_RESET_PASSWORD e depois REMOVA essa variável.`);
}
recoverMaster();

module.exports = { db, tx, one, all, run, getSetting, getSettings, setSetting, DATA_DIR, UPLOAD_DIR };
