'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { one, all, run, getSettings, setSetting } = require('../db');
const C = require('../common');
const { isConfigured, MODEL } = require('../services/ocr');
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
  });
}));

// ---------- Usuários ----------
const USER_COLS = 'u.id, u.name, u.email, u.role, u.supervisor_id, u.cost_center, u.department, u.cpf, u.active, u.created_at, s.name AS supervisor_name';

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
  res.json({ ...getSettings(), ocr_enabled: isConfigured(), ocr_model: MODEL });
}));

r.put('/settings', requireRole('master', 'gestor'), wrap((req, res) => {
  const allowed = ['company_name', 'supervisor_approval_limit_cents', 'supervisor_editable_fields', 'notify_owner_draft_edits', 'max_days_to_submit'];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    let v = req.body[k];
    if (k === 'supervisor_editable_fields') {
      if (!Array.isArray(v)) throw bad('Lista de campos inválida');
      v = JSON.stringify(v.filter((f) => C.EXPENSE_FIELDS[f]));
    }
    setSetting(k, v);
  }
  res.json({ ok: true });
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
