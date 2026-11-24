'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { one, all, run, getSettings, setSetting } = require('../db');
const C = require('../common');
const { isConfigured, MODEL } = require('../services/ocr');
const email = require('../services/email');
const { authenticate, requireRole, wrap, bad, forbidden, notFound, signToken } = C;

const r = express.Router();

// ---------- Autenticação ----------
r.post('/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = one('SELECT * FROM users WHERE email = ?', String(email || '').trim());
  if (!u || !u.active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    throw new C.HttpError(401, 'E-mail ou senha inválidos');
  }
  delete u.password_hash;
  res.json({ token: signToken(u), user: u });
}));

r.use(authenticate);

r.get('/me', wrap((req, res) => {
  const team = req.user.role === 'supervisor'
    ? all('SELECT id, name FROM users WHERE supervisor_id = ? AND active = 1 ORDER BY name', req.user.id) : [];
  const sup = req.user.supervisor_id ? one('SELECT id, name FROM users WHERE id = ?', req.user.supervisor_id) : null;
  res.json({ ...req.user, team, supervisor: sup });
}));

r.post('/me/password', wrap((req, res) => {
  const { current, password } = req.body || {};
  const u = one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw bad('Senha atual incorreta');
  if (!password || String(password).length < 6) throw bad('A nova senha deve ter ao menos 6 caracteres');
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(String(password), 10), req.user.id);
  res.json({ ok: true });
}));

r.put('/me/preferences', wrap((req, res) => {
  const b = req.body || {};
  if (b.email_notifications !== undefined) run('UPDATE users SET email_notifications = ? WHERE id = ?', b.email_notifications ? 1 : 0, req.user.id);
  res.json({ ok: true });
}));

// ---------- Metadados (listas de domínio) ----------
r.get('/meta', wrap((req, res) => {
  const s = getSettings();
  res.json({
    roles: C.ROLES, payment_methods: C.PAYMENT_METHODS, doc_types: C.DOC_TYPES,
    expense_status: C.EXPENSE_STATUS, report_status: C.REPORT_STATUS, advance_status: C.ADVANCE_STATUS,
    fields: C.EXPENSE_FIELDS,
    categories: all('SELECT id, name, limit_cents, requires_receipt, active FROM categories ORDER BY name'),
    company_name: s.company_name,
    supervisor_editable_fields: JSON.parse(s.supervisor_editable_fields || '[]'),
    ocr_enabled: isConfigured(),
    email_configured: email.isConfigured(),
  });
}));

// ---------- Usuários ----------
const USER_COLS = 'u.id, u.name, u.email, u.role, u.supervisor_id, u.cost_center, u.department, u.cpf, u.active, u.email_notifications, u.created_at, s.name AS supervisor_name';

r.get('/users', wrap((req, res) => {
  let rows;
  if (C.isAdmin(req.user)) {
    rows = all(`SELECT ${USER_COLS} FROM users u LEFT JOIN users s ON s.id = u.supervisor_id ORDER BY u.active DESC, u.name`);
  } else if (req.user.role === 'supervisor') {
    rows = all(`SELECT ${USER_COLS} FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.id = ? OR u.supervisor_id = ? ORDER BY u.name`, req.user.id, req.user.id);
  } else {
    rows = all(`SELECT ${USER_COLS} FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.id = ?`, req.user.id);
  }
  res.json(rows);
}));

function validateUserPayload(actor, body, existing) {
  const role = body.role ?? existing?.role;
  if (!C.ROLES[role]) throw bad('Perfil inválido');
  // Somente o master pode criar/alterar masters e gestores
  if (actor.role !== 'master' && (role === 'master' || role === 'gestor' || existing?.role === 'master' || existing?.role === 'gestor')) {
    throw forbidden('Somente o administrador master pode gerenciar gestores e masters');
  }
  if (body.supervisor_id) {
    const s = one('SELECT id, role FROM users WHERE id = ?', body.supervisor_id);
    if (!s || !['supervisor', 'gestor', 'master'].includes(s.role)) throw bad('Supervisor inválido');
    if (existing && Number(body.supervisor_id) === existing.id) throw bad('Usuário não pode ser supervisor de si mesmo');
  }
}

r.post('/users', requireRole('master', 'gestor'), wrap((req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) throw bad('Nome e e-mail são obrigatórios');
  if (!b.password || String(b.password).length < 6) throw bad('Senha inicial deve ter ao menos 6 caracteres');
  validateUserPayload(req.user, b, null);
  if (one('SELECT id FROM users WHERE email = ?', b.email)) throw bad('E-mail já cadastrado');
  const info = run(`INSERT INTO users(name,email,password_hash,role,supervisor_id,cost_center,department,cpf) VALUES(?,?,?,?,?,?,?,?)`,
    b.name.trim(), b.email.trim(), bcrypt.hashSync(String(b.password), 10), b.role,
    b.supervisor_id || null, b.cost_center || null, b.department || null, b.cpf || null);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
}));

r.put('/users/:id', requireRole('master', 'gestor'), wrap((req, res) => {
  const u = one('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw notFound();
  const b = req.body || {};
  validateUserPayload(req.user, b, u);
  if (u.id === req.user.id && b.active === false) throw bad('Você não pode desativar o próprio usuário');
  if (b.email && b.email !== u.email && one('SELECT id FROM users WHERE email = ? AND id <> ?', b.email, u.id)) throw bad('E-mail já cadastrado');
  run(`UPDATE users SET name=?, email=?, role=?, supervisor_id=?, cost_center=?, department=?, cpf=?, active=? WHERE id=?`,
    b.name ?? u.name, b.email ?? u.email, b.role ?? u.role,
    b.supervisor_id === undefined ? u.supervisor_id : (b.supervisor_id || null),
    b.cost_center ?? u.cost_center, b.department ?? u.department, b.cpf ?? u.cpf,
    b.active === undefined ? u.active : (b.active ? 1 : 0), u.id);
  if (b.email_notifications !== undefined) run('UPDATE users SET email_notifications = ? WHERE id = ?', b.email_notifications ? 1 : 0, u.id);
  if (b.password) {
    if (String(b.password).length < 6) throw bad('Senha deve ter ao menos 6 caracteres');
    run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(String(b.password), 10), u.id);
  }
  res.json({ ok: true });
}));

// ---------- Categorias ----------
r.post('/categories', requireRole('master', 'gestor'), wrap((req, res) => {
  const b = req.body || {};
  if (!b.name) throw bad('Nome obrigatório');
  const info = run('INSERT INTO categories(name, limit_cents, requires_receipt, active) VALUES(?,?,?,1)',
    b.name.trim(), C.toCents(b.limit), b.requires_receipt === false ? 0 : 1);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
}));

r.put('/categories/:id', requireRole('master', 'gestor'), wrap((req, res) => {
  const c = one('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!c) throw notFound();
  const b = req.body || {};
  run('UPDATE categories SET name=?, limit_cents=?, requires_receipt=?, active=? WHERE id=?',
    b.name ?? c.name, b.limit === undefined ? c.limit_cents : C.toCents(b.limit),
    b.requires_receipt === undefined ? c.requires_receipt : (b.requires_receipt ? 1 : 0),
    b.active === undefined ? c.active : (b.active ? 1 : 0), c.id);
  res.json({ ok: true });
}));

// ---------- Configurações ----------
r.get('/settings', requireRole('master', 'gestor'), wrap((req, res) => {
  res.json({
    ...getSettings(), ocr_enabled: isConfigured(), ocr_model: MODEL,
    email_configured: email.isConfigured(), email_from: email.isConfigured() ? email.fromAddress() : null, app_url: email.appUrl(),
  });
}));

r.put('/settings', requireRole('master', 'gestor'), wrap((req, res) => {
  const allowed = ['company_name', 'supervisor_approval_limit_cents', 'supervisor_editable_fields', 'notify_owner_draft_edits', 'max_days_to_submit',
    'email_enabled', 'email_types', 'reminder_hour'];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    let v = req.body[k];
    if (k === 'supervisor_editable_fields') {
      if (!Array.isArray(v)) throw bad('Lista de campos inválida');
      v = JSON.stringify(v.filter((f) => C.EXPENSE_FIELDS[f]));
    }
    if (k === 'email_types') {
      if (!Array.isArray(v)) throw bad('Lista de tipos inválida');
      v = JSON.stringify(v.filter((t) => EMAIL_TYPES[t]));
    }
    if (k === 'email_enabled') v = v === true || v === '1' || v === 1 ? '1' : '0';
    if (k === 'reminder_hour' && v !== '' && v !== null && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23)) throw bad('Hora do lembrete inválida (0 a 23)');
    if (k === 'reminder_hour' && v === null) v = '';
    setSetting(k, v);
  }
  res.json({ ok: true });
}));

// ---------- E-mail ----------
const EMAIL_TYPES = {
  edicao_despesa: 'Edição de despesa (antes/depois)',
  exclusao_despesa: 'Exclusão de despesa',
  aprovacao_pendente: 'Prestação aguardando aprovação',
  aprovada_alcada: 'Aprovação na alçada do supervisor',
  prestacao_status: 'Mudança de situação da prestação (aprovada, devolvida, rejeitada, finalizada)',
  glosa: 'Glosa de despesa',
  adiantamento: 'Adiantamentos (solicitação, aprovação, pagamento)',
  despesa_lancada: 'Despesa lançada em nome do colaborador',
};
r.get('/email/types', requireRole('master', 'gestor'), (req, res) => res.json(EMAIL_TYPES));

r.post('/email/test', requireRole('master', 'gestor'), wrap(async (req, res) => {
  const to = String(req.body?.to || req.user.email).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw bad('E-mail inválido');
  try {
    await email.sendTest(to);
  } catch (e) {
    throw bad(`Falha no envio: ${e.message}`);
  }
  res.json({ ok: true, to });
}));

r.get('/email/log', requireRole('master', 'gestor'), wrap((req, res) => {
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM email_outbox GROUP BY status').map((x) => [x.status, x.n]));
  const items = all(`SELECT o.id, o.to_email, o.subject, o.type, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, u.name AS user_name
    FROM email_outbox o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100`);
  res.json({ counts, items });
}));

r.post('/email/log/:id/retry', requireRole('master', 'gestor'), wrap(async (req, res) => {
  run(`UPDATE email_outbox SET status = 'pendente', attempts = 0, next_attempt_at = datetime('now','localtime') WHERE id = ? AND status <> 'enviado'`, req.params.id);
  await email.processQueue();
  res.json(one('SELECT id, status, last_error FROM email_outbox WHERE id = ?', req.params.id));
}));

r.post('/email/reminders', requireRole('master', 'gestor'), wrap(async (req, res) => {
  if (!email.isEnabled()) throw bad('Avisos por e-mail desativados ou SMTP não configurado');
  const n = email.sendDailyReminders({ force: true });
  await email.processQueue();
  res.json({ ok: true, recipients: n });
}));

// ---------- Notificações ----------
r.get('/notifications', wrap((req, res) => {
  const unreadOnly = req.query.unread === '1';
  const rows = all(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 200`, req.user.id)
    .map((n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null }));
  const unread = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).n;
  res.json({ unread, items: rows });
}));
r.post('/notifications/read-all', wrap((req, res) => {
  run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE user_id = ? AND read_at IS NULL`, req.user.id);
  res.json({ ok: true });
}));
r.post('/notifications/:id/read', wrap((req, res) => {
  run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE id = ? AND user_id = ?`, req.params.id, req.user.id);
  res.json({ ok: true });
}));

module.exports = r;
