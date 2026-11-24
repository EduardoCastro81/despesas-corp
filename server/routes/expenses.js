'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { one, all, run, tx, getSetting, UPLOAD_DIR } = require('../db');
const C = require('../common');
const { notify, notifyManagers, diffExpense } = require('../services/notify');
const ocr = require('../services/ocr');
const { authenticate, wrap, bad, forbidden, notFound, isAdmin } = C;

const r = express.Router();
r.use(authenticate);

// ---------- Consulta com filtros (compartilhada com relatórios) ----------
const BASE_SELECT = `
  SELECT e.*, u.name AS user_name, u.supervisor_id AS user_supervisor_id, c.name AS category_name, c.limit_cents AS category_limit_cents,
         rp.title AS report_title, rp.status AS report_status,
         COALESCE(e.advance_id, rp.advance_id) AS linked_advance_id,
         (SELECT COUNT(*) FROM attachments a WHERE a.expense_id = e.id) AS attachment_count,
         (SELECT a.id FROM attachments a WHERE a.expense_id = e.id ORDER BY a.id LIMIT 1) AS first_attachment_id,
         (SELECT COUNT(*) FROM expense_edits x WHERE x.expense_id = e.id AND x.action = 'edicao') AS edit_count,
         CASE WHEN c.limit_cents IS NOT NULL AND e.amount_cents > c.limit_cents THEN 1 ELSE 0 END AS over_limit,
         CASE WHEN EXISTS (SELECT 1 FROM expenses d WHERE d.id <> e.id AND (
              (e.access_key IS NOT NULL AND e.access_key <> '' AND d.access_key = e.access_key)
           OR (e.doc_number IS NOT NULL AND e.doc_number <> '' AND d.doc_number = e.doc_number AND COALESCE(d.supplier_doc,'') = COALESCE(e.supplier_doc,'') AND d.amount_cents = e.amount_cents)
           OR (d.user_id = e.user_id AND d.expense_date = e.expense_date AND d.amount_cents = e.amount_cents AND COALESCE(d.supplier_name,'') = COALESCE(e.supplier_name,''))
         )) THEN 1 ELSE 0 END AS possible_duplicate
  FROM expenses e
  JOIN users u ON u.id = e.user_id
  LEFT JOIN categories c ON c.id = e.category_id
  LEFT JOIN reports rp ON rp.id = e.report_id`;

const listParam = (v) => (v === undefined || v === '' ? [] : String(v).split(',').filter(Boolean));

function buildWhere(user, q) {
  const scope = C.scopeSql(user);
  const w = [scope.sql];
  const p = [...scope.params];
  const inList = (col, vals) => { if (vals.length) { w.push(`${col} IN (${vals.map(() => '?').join(',')})`); p.push(...vals); } };
  inList('e.user_id', listParam(q.user_id).map(Number));
  inList('e.category_id', listParam(q.category_id).map(Number));
  inList('e.payment_method', listParam(q.payment_method));
  inList('e.doc_type', listParam(q.doc_type));
  inList('e.status', listParam(q.status));
  inList('rp.status', listParam(q.report_status));
  if (q.date_from) { w.push('e.expense_date >= ?'); p.push(q.date_from); }
  if (q.date_to) { w.push('e.expense_date <= ?'); p.push(q.date_to); }
  if (q.report_id) { w.push('e.report_id = ?'); p.push(Number(q.report_id)); }
  if (q.no_report === '1') w.push('e.report_id IS NULL');
  if (q.cost_center) { w.push('e.cost_center = ?'); p.push(q.cost_center); }
  if (q.supervisor_id) { w.push('(u.supervisor_id = ? OR u.id = ?)'); p.push(Number(q.supervisor_id), Number(q.supervisor_id)); }
  if (q.has_advance === '1') w.push('COALESCE(e.advance_id, rp.advance_id) IS NOT NULL');
  if (q.has_advance === '0') w.push('COALESCE(e.advance_id, rp.advance_id) IS NULL');
  if (q.min_amount) { w.push('e.amount_cents >= ?'); p.push(C.toCents(q.min_amount)); }
  if (q.max_amount) { w.push('e.amount_cents <= ?'); p.push(C.toCents(q.max_amount)); }
  if (q.q) {
    w.push(`(e.supplier_name LIKE ? OR e.description LIKE ? OR e.doc_number LIKE ? OR e.supplier_doc LIKE ? OR u.name LIKE ?)`);
    const s = `%${q.q}%`; p.push(s, s, s, s, s);
  }
  if (q.edited === '1') w.push(`EXISTS (SELECT 1 FROM expense_edits x WHERE x.expense_id = e.id AND x.action = 'edicao')`);
  if (q.no_receipt === '1') w.push('NOT EXISTS (SELECT 1 FROM attachments a WHERE a.expense_id = e.id)');
  return { where: w.join(' AND '), params: p };
}

function shape(e) {
  if (!e) return e;
  return {
    ...e,
    amount: C.fromCents(e.amount_cents),
    category_limit: C.fromCents(e.category_limit_cents),
    ocr_data: e.ocr_data ? JSON.parse(e.ocr_data) : null,
    has_advance: e.linked_advance_id ? 1 : 0,
  };
}

function queryExpenses(user, q, { limit = 5000 } = {}) {
  const { where, params } = buildWhere(user, q);
  let rows = all(`${BASE_SELECT} WHERE ${where} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${Number(limit)}`, ...params).map(shape);
  if (q.flag === 'over_limit') rows = rows.filter((x) => x.over_limit);
  if (q.flag === 'duplicate') rows = rows.filter((x) => x.possible_duplicate);
  if (q.flag === 'any') rows = rows.filter((x) => x.over_limit || x.possible_duplicate || !x.attachment_count);
  return rows;
}

function getExpense(id) {
  return shape(one(`${BASE_SELECT} WHERE e.id = ?`, id));
}

// ---------- Permissões de edição ----------
const OWNER_EDITABLE_REPORT = [null, 'rascunho', 'devolvida'];

function editPolicy(user, exp) {
  // Retorna { allowed, fields: 'all' | [..], reason }
  if (!exp) return { allowed: false, reason: 'Não encontrado' };
  const rs = exp.report_status || null;
  if (user.role === 'master') return { allowed: true, fields: 'all' };
  if (rs === 'finalizada') return { allowed: false, reason: 'Prestação de contas finalizada' };
  if (user.role === 'gestor') return { allowed: true, fields: 'all' };
  if (exp.user_id === user.id) {
    if (OWNER_EDITABLE_REPORT.includes(rs)) return { allowed: true, fields: 'all' };
    return { allowed: false, reason: 'A despesa está em análise e não pode ser alterada pelo colaborador' };
  }
  if (user.role === 'supervisor' && C.teamIds(user).includes(exp.user_id)) {
    if (rs !== 'aguardando_supervisor' && rs !== null && rs !== 'rascunho' && rs !== 'devolvida') {
      return { allowed: false, reason: 'O supervisor só edita lançamentos do time antes da aprovação do gestor' };
    }
    return { allowed: true, fields: JSON.parse(getSetting('supervisor_editable_fields') || '[]') };
  }
  return { allowed: false, reason: 'Sem permissão' };
}

function canView(user, exp) {
  return exp && C.canSeeUser(user, exp.user_id);
}

// ---------- Normalização/validação ----------
function normalize(body, base = {}) {
  const out = {};
  const s = (v) => (v === undefined ? undefined : (v === null ? null : String(v).trim() || null));
  if (body.expense_date !== undefined) out.expense_date = body.expense_date;
  if (body.amount !== undefined) out.amount_cents = C.toCents(body.amount);
  if (body.category_id !== undefined) out.category_id = body.category_id ? Number(body.category_id) : null;
  for (const f of ['payment_method', 'doc_type', 'doc_number', 'supplier_name', 'description', 'city', 'cost_center']) {
    if (body[f] !== undefined) out[f] = s(body[f]);
  }
  if (body.supplier_doc !== undefined) out.supplier_doc = s(body.supplier_doc) ? String(body.supplier_doc).replace(/\D/g, '') || null : null;
  if (body.access_key !== undefined) out.access_key = s(body.access_key) ? String(body.access_key).replace(/\D/g, '') || null : null;
  if (body.advance_id !== undefined) out.advance_id = body.advance_id ? Number(body.advance_id) : null;

  const m = { ...base, ...out };
  if (!C.isDate(m.expense_date)) throw bad('Data da despesa inválida');
  if (m.expense_date > new Date().toISOString().slice(0, 10)) throw bad('A data da despesa não pode ser futura');
  if (!m.amount_cents || m.amount_cents <= 0) throw bad('Informe um valor maior que zero');
  if (!C.PAYMENT_METHODS[m.payment_method]) throw bad('Forma de pagamento inválida');
  if (!C.DOC_TYPES[m.doc_type]) throw bad('Tipo de documento inválido');
  if (!m.category_id || !one('SELECT id FROM categories WHERE id = ?', m.category_id)) throw bad('Selecione a categoria');
  if (m.access_key && m.access_key.length !== 44) throw bad('A chave de acesso deve ter 44 dígitos');
  if (m.advance_id) {
    const a = one('SELECT user_id, status FROM advances WHERE id = ?', m.advance_id);
    if (!a || a.user_id !== m.user_id) throw bad('Adiantamento inválido para este colaborador');
    if (!['aprovado', 'pago'].includes(a.status)) throw bad('Adiantamento não está disponível');
  }
  return out;
}

const SNAP_FIELDS = Object.keys(C.EXPENSE_FIELDS);
const snapshot = (e) => Object.fromEntries(SNAP_FIELDS.map((f) => [f, e[f] ?? null]));

function attachFiles(expenseId, ids, user) {
  for (const id of (ids || []).map(Number)) {
    const a = one('SELECT * FROM attachments WHERE id = ?', id);
    if (!a) continue;
    if (a.uploaded_by !== user.id && !isAdmin(user)) continue;
    if (a.expense_id && a.expense_id !== expenseId) continue;
    run('UPDATE attachments SET expense_id = ? WHERE id = ?', expenseId, id);
  }
}

// ---------- Rotas ----------
r.get('/expenses', wrap((req, res) => {
  const rows = queryExpenses(req.user, req.query, { limit: req.query.limit || 2000 });
  const total = rows.reduce((s, x) => s + x.amount_cents, 0);
  res.json({ count: rows.length, total: C.fromCents(total), items: rows });
}));

r.get('/expenses/export', wrap(async (req, res) => {
  const rows = queryExpenses(req.user, req.query, { limit: 100000 });
  const cols = [
    ['ID', (e) => e.id], ['Data', (e) => e.expense_date], ['Colaborador', (e) => e.user_name], ['Categoria', (e) => e.category_name],
    ['Valor', (e) => e.amount], ['Forma de pagamento', (e) => C.PAYMENT_METHODS[e.payment_method]],
    ['Documento', (e) => C.DOC_TYPES[e.doc_type]], ['Nº doc', (e) => e.doc_number], ['Fornecedor', (e) => e.supplier_name],
    ['CNPJ/CPF', (e) => e.supplier_doc], ['Cidade', (e) => e.city], ['Centro de custo', (e) => e.cost_center],
    ['Descrição', (e) => e.description], ['Status', (e) => C.EXPENSE_STATUS[e.status]],
    ['Prestação', (e) => (e.report_id ? `#${e.report_id} ${e.report_title}` : '')], ['Status prestação', (e) => C.REPORT_STATUS[e.report_status] || ''],
    ['Adiantamento', (e) => (e.linked_advance_id ? `#${e.linked_advance_id}` : 'Não')], ['Acima do limite', (e) => (e.over_limit ? 'Sim' : '')],
    ['Possível duplicidade', (e) => (e.possible_duplicate ? 'Sim' : '')], ['Comprovantes', (e) => e.attachment_count], ['Editada', (e) => (e.edit_count ? 'Sim' : '')],
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Despesas');
    ws.columns = cols.map(([h]) => ({ header: h, width: Math.max(12, h.length + 4) }));
    for (const e of rows) ws.addRow(cols.map(([, f]) => f(e) ?? ''));
    ws.getRow(1).font = { bold: true };
    ws.getColumn(5).numFmt = '"R$" #,##0.00';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="despesas-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(([h]) => h).join(';')];
  for (const e of rows) lines.push(cols.map(([h, f]) => (h === 'Valor' ? String(f(e)).replace('.', ',') : csvCell(f(e)))).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="despesas-${stamp}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

r.get('/expenses/:id', wrap((req, res) => {
  const e = getExpense(req.params.id);
  if (!canView(req.user, e)) throw notFound();
  const attachments = all('SELECT id, original_name, mime, size, created_at FROM attachments WHERE expense_id = ? ORDER BY id', e.id);
  const edits = all(`SELECT x.*, u.name AS editor_name FROM expense_edits x JOIN users u ON u.id = x.editor_id WHERE x.expense_id = ? ORDER BY x.id DESC`, e.id)
    .map((x) => ({ ...x, changes: JSON.parse(x.changes), before_data: undefined, after_data: undefined }));
  const policy = editPolicy(req.user, e);
  res.json({ ...e, attachments, edits, can_edit: policy.allowed, editable_fields: policy.fields || [], edit_block_reason: policy.reason || null });
}));

r.post('/expenses', wrap((req, res) => {
  const b = req.body || {};
  let ownerId = req.user.id;
  if (b.user_id && Number(b.user_id) !== req.user.id) {
    if (!isAdmin(req.user)) throw forbidden('Somente gestores lançam despesas para outros usuários');
    ownerId = Number(b.user_id);
    if (!one('SELECT id FROM users WHERE id = ? AND active = 1', ownerId)) throw bad('Colaborador inválido');
  }
  const owner = one('SELECT cost_center FROM users WHERE id = ?', ownerId);
  const data = normalize(b, { user_id: ownerId });
  const maxDays = Number(getSetting('max_days_to_submit') || 0);
  if (maxDays > 0) {
    const days = (Date.now() - new Date(data.expense_date + 'T12:00:00').getTime()) / 86400000;
    if (days > maxDays && !isAdmin(req.user)) throw bad(`Despesas com mais de ${maxDays} dias não podem ser lançadas. Procure o gestor.`);
  }
  const id = tx(() => {
    const info = run(`INSERT INTO expenses(user_id, category_id, expense_date, amount_cents, payment_method, doc_type, doc_number, access_key,
        supplier_name, supplier_doc, description, city, cost_center, advance_id, ocr_data, created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ownerId, data.category_id, data.expense_date, data.amount_cents, data.payment_method, data.doc_type, data.doc_number ?? null,
      data.access_key ?? null, data.supplier_name ?? null, data.supplier_doc ?? null, data.description ?? null, data.city ?? null,
      data.cost_center ?? owner?.cost_center ?? null, data.advance_id ?? null, b.ocr_data ? JSON.stringify(b.ocr_data) : null, req.user.id);
    const newId = Number(info.lastInsertRowid);
    attachFiles(newId, b.attachment_ids, req.user);
    if (b.report_id) addToReport(req.user, Number(b.report_id), [newId]);
    return newId;
  });
  if (ownerId !== req.user.id) {
    notify(ownerId, { type: 'despesa_lancada', title: `${req.user.name} lançou uma despesa em seu nome`, body: `Despesa #${id}`, link: `#/despesa/${id}` });
  }
  res.status(201).json(getExpense(id));
}));

r.put('/expenses/:id', wrap((req, res) => {
  const e = getExpense(req.params.id);
  if (!canView(req.user, e)) throw notFound();
  const policy = editPolicy(req.user, e);
  if (!policy.allowed) throw forbidden(policy.reason);
  const b = req.body || {};
  const reason = (b.reason || '').trim();
  const isOwner = e.user_id === req.user.id;
  if (!isOwner && !reason) throw bad('Informe a justificativa da edição');

  const data = normalize(b, { ...snapshot(e), user_id: e.user_id });
  if (policy.fields !== 'all') {
    const before = snapshot(e);
    for (const f of Object.keys(data)) {
      if (String(data[f] ?? '') !== String(before[f] ?? '') && !policy.fields.includes(f)) {
        throw forbidden(`Seu perfil não pode alterar o campo "${C.EXPENSE_FIELDS[f] || f}"`);
      }
    }
  }
  const before = snapshot(e);
  const after = { ...before, ...data };
  const changes = diffExpense(before, after);
  const newAttachments = (b.attachment_ids || []).filter((id) => !one('SELECT 1 FROM attachments WHERE id = ? AND expense_id = ?', id, e.id));
  if (!changes.length && !newAttachments.length) return res.json(getExpense(e.id));
  if (newAttachments.length) changes.push({ field: 'attachments', label: 'Comprovantes', before: `${e.attachment_count} arquivo(s)`, after: `${e.attachment_count + newAttachments.length} arquivo(s)` });

  tx(() => {
    const sets = Object.keys(data).map((k) => `${k} = ?`);
    if (sets.length) run(`UPDATE expenses SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`, ...Object.values(data), e.id);
    attachFiles(e.id, newAttachments, req.user);
    run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, before_data, after_data, reason) VALUES(?,?,?,?,?,?,?,?)`,
      e.id, req.user.id, req.user.role, 'edicao', JSON.stringify(changes), JSON.stringify(before), JSON.stringify(after), reason || null);
  });

  // Toda edição notifica o gestor com o antes/depois
  const ownDraft = isOwner && OWNER_EDITABLE_REPORT.includes(e.report_status || null) && e.report_status !== 'devolvida';
  if (!ownDraft || getSetting('notify_owner_draft_edits') === '1') {
    const summary = changes.map((c) => `${c.label}: ${c.before} → ${c.after}`).join('\n');
    notifyManagers({
      type: 'edicao_despesa',
      title: `${C.ROLES[req.user.role]} ${req.user.name} editou a despesa #${e.id} de ${e.user_name}`,
      body: summary + (reason ? `\nJustificativa: ${reason}` : ''),
      link: `#/despesa/${e.id}`,
      data: { expense_id: e.id, editor: req.user.name, editor_role: req.user.role, changes, reason },
    }, req.user.id);
  }
  if (!isOwner) {
    notify(e.user_id, {
      type: 'edicao_despesa', title: `Sua despesa #${e.id} foi editada por ${req.user.name}`,
      body: changes.map((c) => `${c.label}: ${c.before} → ${c.after}`).join('\n') + (reason ? `\nJustificativa: ${reason}` : ''),
      link: `#/despesa/${e.id}`, data: { expense_id: e.id, changes },
    });
  }
  res.json(getExpense(e.id));
}));

r.delete('/expenses/:id', wrap((req, res) => {
  const e = getExpense(req.params.id);
  if (!canView(req.user, e)) throw notFound();
  const ownerCan = e.user_id === req.user.id && OWNER_EDITABLE_REPORT.includes(e.report_status || null);
  if (!ownerCan && !isAdmin(req.user)) throw forbidden('Sem permissão para excluir');
  if (e.report_status === 'finalizada' && req.user.role !== 'master') throw forbidden('Prestação finalizada');
  const reason = (req.body?.reason || req.query.reason || '').trim();
  if (e.user_id !== req.user.id && !reason) throw bad('Informe a justificativa da exclusão');
  const files = all('SELECT stored_name FROM attachments WHERE expense_id = ?', e.id);
  tx(() => {
    run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, before_data, reason) VALUES(?,?,?,?,?,?,?)`,
      e.id, req.user.id, req.user.role, 'exclusao', JSON.stringify([{ field: '*', label: 'Despesa excluída', before: `${C.brl(e.amount_cents)} — ${e.supplier_name || e.category_name}`, after: '—' }]),
      JSON.stringify(snapshot(e)), reason || null);
    run('DELETE FROM expenses WHERE id = ?', e.id);
  });
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  if (e.report_id || e.user_id !== req.user.id) {
    notifyManagers({ type: 'exclusao_despesa', title: `${req.user.name} excluiu a despesa #${e.id} de ${e.user_name}`,
      body: `${C.brl(e.amount_cents)} — ${e.supplier_name || ''} (${e.expense_date})${reason ? `\nJustificativa: ${reason}` : ''}`, link: '#/auditoria' }, req.user.id);
  }
  res.json({ ok: true });
}));

// Revisão item a item (glosa) pelo aprovador da etapa atual
r.post('/expenses/:id/review', wrap((req, res) => {
  const e = getExpense(req.params.id);
  if (!canView(req.user, e)) throw notFound();
  if (!e.report_id) throw bad('A despesa não pertence a uma prestação de contas');
  const report = one('SELECT r.*, u.supervisor_id FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?', e.report_id);
  const { canActOnReport } = require('./reports');
  if (!canActOnReport(req.user, report)) throw forbidden('Você não é o aprovador desta etapa');
  const action = req.body?.action;
  const reason = (req.body?.reason || '').trim();
  if (action === 'glosar') {
    if (!reason) throw bad('Informe o motivo da glosa');
    run(`UPDATE expenses SET status = 'glosada', glosa_reason = ?, updated_at = datetime('now','localtime') WHERE id = ?`, reason, e.id);
  } else if (action === 'restaurar') {
    run(`UPDATE expenses SET status = 'em_analise', glosa_reason = NULL, updated_at = datetime('now','localtime') WHERE id = ?`, e.id);
  } else throw bad('Ação inválida');
  run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, reason) VALUES(?,?,?,?,?,?)`,
    e.id, req.user.id, req.user.role, action === 'glosar' ? 'glosa' : 'restauracao',
    JSON.stringify([{ field: 'status', label: 'Situação', before: C.EXPENSE_STATUS[e.status], after: action === 'glosar' ? 'Glosada' : 'Em análise' }]), reason || null);
  notify(e.user_id, { type: 'glosa', title: action === 'glosar' ? `Despesa #${e.id} glosada` : `Glosa da despesa #${e.id} removida`, body: reason || null, link: `#/prestacao/${e.report_id}` });
  if (req.user.role === 'supervisor') {
    notifyManagers({ type: 'glosa', title: `Supervisor ${req.user.name} ${action === 'glosar' ? 'glosou' : 'restaurou'} a despesa #${e.id} de ${e.user_name}`,
      body: `${C.brl(e.amount_cents)} — ${reason}`, link: `#/despesa/${e.id}` });
  }
  res.json(getExpense(e.id));
}));

// ---------- Upload de comprovantes e leitura automática ----------
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(bad('Formato não suportado. Envie JPG, PNG, WEBP ou PDF.'))),
});

r.post('/uploads', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Arquivo não enviado');
  const info = run('INSERT INTO attachments(stored_name, original_name, mime, size, uploaded_by) VALUES(?,?,?,?,?)',
    req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user.id);
  const attachment = { id: Number(info.lastInsertRowid), original_name: req.file.originalname, mime: req.file.mimetype, size: req.file.size };
  let extraction = null;
  let extraction_error = null;
  if (req.query.ocr === '1') {
    if (!ocr.isConfigured()) {
      extraction_error = 'Leitura automática não configurada no servidor (defina ANTHROPIC_API_KEY). Preencha os campos manualmente.';
    } else {
      try {
        const cats = all('SELECT id, name FROM categories WHERE active = 1');
        const x = await ocr.extractReceipt(req.file.path, req.file.mimetype, cats.map((c) => c.name));
        const cat = cats.find((c) => c.name === x.category_suggestion);
        extraction = { ...x, category_id: cat ? cat.id : null };
      } catch (err) {
        console.error('[ocr]', err.message);
        extraction_error = err.message?.startsWith('A leitura') || err.message?.startsWith('Resposta') ? err.message
          : 'Não foi possível ler o comprovante automaticamente. Preencha os campos manualmente.';
      }
    }
  }
  res.status(201).json({ attachment, extraction, extraction_error });
}));

r.delete('/attachments/:id', wrap((req, res) => {
  const a = one('SELECT * FROM attachments WHERE id = ?', req.params.id);
  if (!a) throw notFound();
  if (a.expense_id) {
    const e = getExpense(a.expense_id);
    const pol = editPolicy(req.user, e);
    if (!pol.allowed || (pol.fields !== 'all')) throw forbidden('Sem permissão para remover comprovante');
    run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, reason) VALUES(?,?,?,?,?,?)`,
      e.id, req.user.id, req.user.role, 'edicao', JSON.stringify([{ field: 'attachments', label: 'Comprovantes', before: a.original_name || `arquivo #${a.id}`, after: 'removido' }]), req.body?.reason || null);
    if (e.user_id !== req.user.id || e.report_id) {
      notifyManagers({ type: 'edicao_despesa', title: `${req.user.name} removeu um comprovante da despesa #${e.id}`, body: a.original_name, link: `#/despesa/${e.id}` }, req.user.id);
    }
  } else if (a.uploaded_by !== req.user.id) throw forbidden();
  run('DELETE FROM attachments WHERE id = ?', a.id);
  fs.rm(path.join(UPLOAD_DIR, a.stored_name), { force: true }, () => {});
  res.json({ ok: true });
}));

r.get('/files/:id', wrap((req, res) => {
  const a = one('SELECT * FROM attachments WHERE id = ?', req.params.id);
  if (!a) throw notFound();
  if (a.expense_id) {
    const e = one('SELECT user_id FROM expenses WHERE id = ?', a.expense_id);
    if (!e || !C.canSeeUser(req.user, e.user_id)) throw notFound();
  } else if (a.uploaded_by !== req.user.id) throw notFound();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.original_name || 'comprovante')}"`);
  res.sendFile(path.join(UPLOAD_DIR, a.stored_name));
}));

// ---------- Auditoria de edições ----------
r.get('/audit', C.requireRole('master', 'gestor', 'supervisor'), wrap((req, res) => {
  const w = ['1=1']; const p = [];
  if (req.user.role === 'supervisor') {
    w.push('(x.editor_id = ? OR (e.user_id IN (SELECT id FROM users WHERE supervisor_id = ?)))'); p.push(req.user.id, req.user.id);
  }
  if (req.query.editor_id) { w.push('x.editor_id = ?'); p.push(Number(req.query.editor_id)); }
  if (req.query.action) { w.push('x.action = ?'); p.push(req.query.action); }
  if (req.query.date_from) { w.push('date(x.created_at) >= ?'); p.push(req.query.date_from); }
  if (req.query.date_to) { w.push('date(x.created_at) <= ?'); p.push(req.query.date_to); }
  if (req.query.expense_id) { w.push('x.expense_id = ?'); p.push(Number(req.query.expense_id)); }
  const rows = all(`SELECT x.id, x.expense_id, x.editor_role, x.action, x.changes, x.reason, x.created_at, ed.name AS editor_name,
      ow.name AS owner_name, e.amount_cents, e.supplier_name
    FROM expense_edits x JOIN users ed ON ed.id = x.editor_id
    LEFT JOIN expenses e ON e.id = x.expense_id LEFT JOIN users ow ON ow.id = e.user_id
    WHERE ${w.join(' AND ')} ORDER BY x.id DESC LIMIT 1000`, ...p).map((x) => ({ ...x, changes: JSON.parse(x.changes) }));
  res.json(rows);
}));

// Usado pelo módulo de prestações
function addToReport(user, reportId, expenseIds) {
  const rp = one('SELECT * FROM reports WHERE id = ?', reportId);
  if (!rp) throw notFound('Prestação não encontrada');
  if (rp.user_id !== user.id && !isAdmin(user)) throw forbidden();
  if (!['rascunho', 'devolvida'].includes(rp.status)) throw bad('A prestação não está aberta para inclusão de despesas');
  for (const id of expenseIds) {
    const e = one('SELECT id, user_id, report_id FROM expenses WHERE id = ?', id);
    if (!e || e.user_id !== rp.user_id) throw bad(`Despesa #${id} não pertence ao titular da prestação`);
    if (e.report_id && e.report_id !== rp.id) throw bad(`Despesa #${id} já está em outra prestação`);
    run(`UPDATE expenses SET report_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, rp.id, id);
  }
}

module.exports = r;
module.exports.queryExpenses = queryExpenses;
module.exports.buildWhere = buildWhere;
module.exports.BASE_SELECT = BASE_SELECT;
module.exports.addToReport = addToReport;
module.exports.getExpense = getExpense;
