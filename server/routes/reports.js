'use strict';
// Prestações de contas, rotina de aprovação e adiantamentos
const express = require('express');
const { one, all, run, tx, getSetting, getSettings } = require('../db');
const C = require('../common');
const { notify, notifyManagers } = require('../services/notify');
const { authenticate, wrap, bad, forbidden, notFound, isAdmin, esc, brl } = C;

const r = express.Router();
r.use(authenticate);

const REPORT_SELECT = `
  SELECT r.*, u.name AS user_name, u.email AS user_email, u.cost_center AS user_cost_center, u.supervisor_id,
    s.name AS supervisor_name, a.amount_cents AS advance_cents, a.status AS advance_status, a.purpose AS advance_purpose,
    (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id) AS expense_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM expenses e WHERE e.report_id = r.id) AS total_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM expenses e WHERE e.report_id = r.id AND e.status = 'glosada') AS glosa_cents
  FROM reports r JOIN users u ON u.id = r.user_id LEFT JOIN users s ON s.id = u.supervisor_id
  LEFT JOIN advances a ON a.id = r.advance_id`;

function shapeReport(x) {
  if (!x) return x;
  const approved = x.total_cents - x.glosa_cents;
  const adv = x.advance_id && ['pago', 'liquidado'].includes(x.advance_status) ? x.advance_cents : 0;
  const balance = approved - adv; // >0 empresa reembolsa; <0 colaborador devolve
  return {
    ...x, total: C.fromCents(x.total_cents), glosa: C.fromCents(x.glosa_cents), approved_total: C.fromCents(approved),
    advance_amount: C.fromCents(adv), balance: C.fromCents(balance),
    balance_label: balance > 0 ? 'A reembolsar ao colaborador' : balance < 0 ? 'A devolver pelo colaborador' : 'Sem saldo',
  };
}
const getReport = (id) => shapeReport(one(`${REPORT_SELECT} WHERE r.id = ?`, id));

// Quem pode agir (aprovar/devolver/rejeitar/glosar) na etapa atual
function canActOnReport(user, rp) {
  if (!rp || rp.user_id === user.id && user.role !== 'master') return false;
  if (rp.status === 'aguardando_supervisor') {
    return user.role === 'master' || user.role === 'gestor' || (user.role === 'supervisor' && rp.supervisor_id === user.id);
  }
  if (rp.status === 'aguardando_gestor') return isAdmin(user);
  return false;
}

function history(reportId, userId, action, from, to, comment) {
  run('INSERT INTO report_history(report_id, user_id, action, from_status, to_status, comment) VALUES(?,?,?,?,?,?)',
    reportId, userId, action, from, to, comment || null);
}

function setStatus(rp, to, user, action, comment, extra = {}) {
  const sets = ['status = ?', "updated_at = datetime('now','localtime')", 'last_comment = ?'];
  const vals = [to, comment || null];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ${v === 'now' ? "datetime('now','localtime')" : '?'}`); if (v !== 'now') vals.push(v); }
  run(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`, ...vals, rp.id);
  history(rp.id, user.id, action, rp.status, to, comment);
}

// ---------- Listagem ----------
r.get('/reports', wrap((req, res) => {
  const scope = C.scopeSql(req.user, 'r.user_id');
  const w = [scope.sql]; const p = [...scope.params];
  const q = req.query;
  if (q.status) { const st = String(q.status).split(','); w.push(`r.status IN (${st.map(() => '?').join(',')})`); p.push(...st); }
  if (q.user_id) { w.push('r.user_id = ?'); p.push(Number(q.user_id)); }
  if (q.mine === '1') { w.push('r.user_id = ?'); p.push(req.user.id); }
  if (q.date_from) { w.push('COALESCE(r.period_end, r.created_at) >= ?'); p.push(q.date_from); }
  if (q.date_to) { w.push('COALESCE(r.period_start, r.created_at) <= ?'); p.push(q.date_to); }
  if (q.has_advance === '1') w.push('r.advance_id IS NOT NULL');
  if (q.has_advance === '0') w.push('r.advance_id IS NULL');
  let rows = all(`${REPORT_SELECT} WHERE ${w.join(' AND ')} ORDER BY r.updated_at DESC LIMIT 1000`, ...p).map(shapeReport);
  rows = rows.map((x) => ({ ...x, can_act: canActOnReport(req.user, x) }));
  if (q.pending_me === '1') rows = rows.filter((x) => x.can_act);
  res.json(rows);
}));

r.get('/reports/:id', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
  const { queryExpenses } = require('./expenses');
  const expenses = queryExpenses(req.user, { report_id: rp.id });
  const hist = all(`SELECT h.*, u.name AS user_name, u.role AS user_role FROM report_history h JOIN users u ON u.id = h.user_id WHERE h.report_id = ? ORDER BY h.id`, rp.id);
  const byCategory = {};
  for (const e of expenses) byCategory[e.category_name || '—'] = (byCategory[e.category_name || '—'] || 0) + (e.status === 'glosada' ? 0 : e.amount);
  const isOwner = rp.user_id === req.user.id;
  res.json({
    ...rp, expenses, history: hist, by_category: byCategory,
    can_act: canActOnReport(req.user, rp),
    can_edit: (isOwner || isAdmin(req.user)) && ['rascunho', 'devolvida'].includes(rp.status),
    can_submit: (isOwner || isAdmin(req.user)) && ['rascunho', 'devolvida'].includes(rp.status) && expenses.length > 0,
    can_finalize: isAdmin(req.user) && rp.status === 'aprovada',
  });
}));

function validateAdvance(advanceId, userId, reportId = null) {
  if (!advanceId) return null;
  const a = one('SELECT * FROM advances WHERE id = ?', advanceId);
  if (!a || a.user_id !== userId) throw bad('Adiantamento inválido para este colaborador');
  if (!['aprovado', 'pago'].includes(a.status)) throw bad('O adiantamento precisa estar aprovado ou pago');
  const used = one(`SELECT id FROM reports WHERE advance_id = ? AND status <> 'rejeitada' AND id <> ?`, advanceId, reportId || 0);
  if (used) throw bad(`Adiantamento já vinculado à prestação #${used.id}`);
  return Number(advanceId);
}

r.post('/reports', wrap((req, res) => {
  const b = req.body || {};
  let ownerId = req.user.id;
  if (b.user_id && Number(b.user_id) !== req.user.id) {
    if (!isAdmin(req.user)) throw forbidden();
    ownerId = Number(b.user_id);
  }
  if (!b.title?.trim()) throw bad('Informe um título para a prestação de contas');
  const id = tx(() => {
    const info = run('INSERT INTO reports(user_id, title, period_start, period_end, advance_id) VALUES(?,?,?,?,?)',
      ownerId, b.title.trim(), b.period_start || null, b.period_end || null, validateAdvance(b.advance_id, ownerId));
    const newId = Number(info.lastInsertRowid);
    history(newId, req.user.id, 'criacao', null, 'rascunho', null);
    if (b.expense_ids?.length) require('./expenses').addToReport(req.user, newId, b.expense_ids.map(Number));
    return newId;
  });
  res.status(201).json(getReport(id));
}));

r.put('/reports/:id', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
  if (rp.user_id !== req.user.id && !isAdmin(req.user)) throw forbidden();
  if (!['rascunho', 'devolvida'].includes(rp.status)) throw bad('Somente prestações em rascunho ou devolvidas podem ser alteradas');
  const b = req.body || {};
  run(`UPDATE reports SET title=?, period_start=?, period_end=?, advance_id=?, updated_at=datetime('now','localtime') WHERE id=?`,
    b.title ?? rp.title, b.period_start ?? rp.period_start, b.period_end ?? rp.period_end,
    b.advance_id === undefined ? rp.advance_id : validateAdvance(b.advance_id, rp.user_id, rp.id), rp.id);
  res.json(getReport(rp.id));
}));

r.delete('/reports/:id', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
  if ((rp.user_id !== req.user.id && !isAdmin(req.user)) || rp.status !== 'rascunho') throw forbidden('Somente rascunhos podem ser excluídos');
  tx(() => {
    run(`UPDATE expenses SET report_id = NULL, status = 'rascunho' WHERE report_id = ?`, rp.id);
    run('DELETE FROM reports WHERE id = ?', rp.id);
  });
  res.json({ ok: true });
}));

r.post('/reports/:id/expenses', wrap((req, res) => {
  const ids = (req.body?.expense_ids || []).map(Number);
  require('./expenses').addToReport(req.user, Number(req.params.id), ids);
  res.json(getReport(req.params.id));
}));

r.delete('/reports/:id/expenses/:eid', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || (rp.user_id !== req.user.id && !isAdmin(req.user))) throw forbidden();
  if (!['rascunho', 'devolvida'].includes(rp.status)) throw bad('Prestação não está aberta para alterações');
  run(`UPDATE expenses SET report_id = NULL, status = 'rascunho' WHERE id = ? AND report_id = ?`, req.params.eid, rp.id);
  res.json(getReport(rp.id));
}));

// ---------- Fluxo de aprovação ----------
r.post('/reports/:id/submit', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || (rp.user_id !== req.user.id && !isAdmin(req.user))) throw notFound();
  if (!['rascunho', 'devolvida'].includes(rp.status)) throw bad('Esta prestação já foi enviada');
  const exps = all(`SELECT e.id, e.category_id, c.requires_receipt, (SELECT COUNT(*) FROM attachments a WHERE a.expense_id = e.id) n
    FROM expenses e LEFT JOIN categories c ON c.id = e.category_id WHERE e.report_id = ?`, rp.id);
  if (!exps.length) throw bad('Inclua ao menos uma despesa antes de enviar');
  const missing = exps.filter((e) => e.requires_receipt && !e.n);
  if (missing.length && !req.body?.confirm_missing_receipts) {
    return res.status(409).json({ error: `Há ${missing.length} despesa(s) sem comprovante anexado: ${missing.map((m) => '#' + m.id).join(', ')}. Confirme para enviar mesmo assim.`, code: 'missing_receipts' });
  }
  const sup = rp.supervisor_id ? one('SELECT id, role, active FROM users WHERE id = ?', rp.supervisor_id) : null;
  const to = sup && sup.active && sup.role === 'supervisor' ? 'aguardando_supervisor' : 'aguardando_gestor';
  tx(() => {
    setStatus(rp, to, req.user, rp.status === 'devolvida' ? 'reenvio' : 'envio', req.body?.comment, { submitted_at: 'now' });
    run(`UPDATE expenses SET status = 'em_analise' WHERE report_id = ? AND status <> 'glosada'`, rp.id);
  });
  const payload = { type: 'aprovacao_pendente', title: `Prestação #${rp.id} de ${rp.user_name} aguardando sua aprovação`, body: `${rp.title} — ${brl(rp.total_cents)}`, link: `#/prestacao/${rp.id}` };
  if (to === 'aguardando_supervisor') notify(sup.id, payload); else notifyManagers(payload);
  res.json(getReport(rp.id));
}));

r.post('/reports/:id/approve', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
  if (!canActOnReport(req.user, rp)) throw forbidden('Você não é o aprovador desta etapa');
  const comment = req.body?.comment;
  let to;
  if (rp.status === 'aguardando_supervisor' && req.user.role === 'supervisor') {
    const limit = Number(getSetting('supervisor_approval_limit_cents') || 0);
    const approvedCents = rp.total_cents - rp.glosa_cents;
    to = limit > 0 && approvedCents <= limit ? 'aprovada' : 'aguardando_gestor';
    tx(() => {
      setStatus(rp, to, req.user, 'aprovacao_supervisor', comment, { supervisor_approved_by: req.user.id, supervisor_approved_at: 'now', ...(to === 'aprovada' ? { approved_by: req.user.id, approved_at: 'now' } : {}) });
      if (to === 'aprovada') run(`UPDATE expenses SET status = 'aprovada' WHERE report_id = ? AND status <> 'glosada'`, rp.id);
    });
    if (to === 'aguardando_gestor') {
      notifyManagers({ type: 'aprovacao_pendente', title: `Prestação #${rp.id} de ${rp.user_name} aprovada pelo supervisor — aguardando gestor`, body: `${rp.title} — ${brl(approvedCents)}${comment ? `\n${comment}` : ''}`, link: `#/prestacao/${rp.id}` });
    } else {
      notifyManagers({ type: 'aprovada_alcada', title: `Prestação #${rp.id} aprovada pelo supervisor dentro da alçada`, body: `${rp.title} — ${brl(approvedCents)}`, link: `#/prestacao/${rp.id}` });
    }
  } else {
    to = 'aprovada';
    tx(() => {
      const extra = { approved_by: req.user.id, approved_at: 'now' };
      if (rp.status === 'aguardando_supervisor') Object.assign(extra, { supervisor_approved_by: req.user.id, supervisor_approved_at: 'now' });
      setStatus(rp, to, req.user, 'aprovacao_gestor', comment, extra);
      run(`UPDATE expenses SET status = 'aprovada' WHERE report_id = ? AND status <> 'glosada'`, rp.id);
    });
  }
  notify(rp.user_id, {
    type: 'prestacao_status', title: to === 'aprovada' ? `Sua prestação #${rp.id} foi aprovada` : `Sua prestação #${rp.id} foi aprovada pelo supervisor`,
    body: comment || (to === 'aprovada' ? 'Aguardando pagamento/liquidação.' : 'Seguiu para aprovação do gestor.'), link: `#/prestacao/${rp.id}`,
  });
  res.json(getReport(rp.id));
}));

function returnOrReject(kind) {
  return wrap((req, res) => {
    const rp = getReport(req.params.id);
    if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
    if (!canActOnReport(req.user, rp)) throw forbidden('Você não é o aprovador desta etapa');
    const comment = (req.body?.comment || '').trim();
    if (!comment) throw bad('Informe o motivo');
    const to = kind === 'return' ? 'devolvida' : 'rejeitada';
    tx(() => {
      setStatus(rp, to, req.user, kind === 'return' ? 'devolucao' : 'rejeicao', comment);
      if (kind === 'return') run(`UPDATE expenses SET status = 'rascunho' WHERE report_id = ? AND status <> 'glosada'`, rp.id);
      else run(`UPDATE expenses SET status = 'glosada', glosa_reason = COALESCE(glosa_reason, ?) WHERE report_id = ?`, 'Prestação rejeitada', rp.id);
    });
    notify(rp.user_id, { type: 'prestacao_status', title: kind === 'return' ? `Prestação #${rp.id} devolvida para ajuste` : `Prestação #${rp.id} rejeitada`, body: comment, link: `#/prestacao/${rp.id}` });
    if (req.user.role === 'supervisor') notifyManagers({ type: 'prestacao_status', title: `Supervisor ${req.user.name} ${kind === 'return' ? 'devolveu' : 'rejeitou'} a prestação #${rp.id} de ${rp.user_name}`, body: comment, link: `#/prestacao/${rp.id}` });
    res.json(getReport(rp.id));
  });
}
r.post('/reports/:id/return', returnOrReject('return'));
r.post('/reports/:id/reject', returnOrReject('reject'));

r.post('/reports/:id/finalize', C.requireRole('master', 'gestor'), wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp) throw notFound();
  if (rp.status !== 'aprovada') throw bad('Somente prestações aprovadas podem ser finalizadas');
  const note = req.body?.note || null;
  tx(() => {
    setStatus(rp, 'finalizada', req.user, 'finalizacao', note, { finalized_by: req.user.id, finalized_at: 'now', settlement_note: note });
    if (rp.advance_id) run(`UPDATE advances SET status = 'liquidado' WHERE id = ?`, rp.advance_id);
  });
  notify(rp.user_id, { type: 'prestacao_status', title: `Prestação #${rp.id} finalizada`, body: `${rp.balance_label}: ${brl(Math.round(Math.abs(rp.balance) * 100))}${note ? `\n${note}` : ''}`, link: `#/prestacao/${rp.id}` });
  res.json(getReport(rp.id));
}));

// ---------- Impressão / PDF da prestação ----------
r.get('/reports/:id/print', wrap((req, res) => {
  const rp = getReport(req.params.id);
  if (!rp || !C.canSeeUser(req.user, rp.user_id)) throw notFound();
  const { queryExpenses } = require('./expenses');
  const exps = queryExpenses(req.user, { report_id: rp.id }).sort((a, b) => a.expense_date.localeCompare(b.expense_date));
  const hist = all(`SELECT h.*, u.name AS user_name, u.role FROM report_history h JOIN users u ON u.id = h.user_id WHERE h.report_id = ? ORDER BY h.id`, rp.id);
  const atts = all(`SELECT a.id, a.expense_id, a.mime FROM attachments a JOIN expenses e ON e.id = a.expense_id WHERE e.report_id = ? ORDER BY a.expense_id, a.id`, rp.id);
  const s = getSettings();
  const d = (x) => (x ? x.slice(0, 10).split('-').reverse().join('/') + (x.length > 10 ? ' ' + x.slice(11, 16) : '') : '—');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Prestação de contas #${rp.id}</title>
<style>
body{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#111;margin:24px;background:#fff}
h1{font-size:18px;margin:0}h2{font-size:14px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f2f2f2}.r{text-align:right}.g{color:#a11;text-decoration:line-through}.muted{color:#555}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 18px;margin-top:10px}.tot td{font-weight:600}
.recs{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.recs figure{margin:0;border:1px solid #ccc;padding:6px;break-inside:avoid}
.recs img{max-width:100%;max-height:420px;display:block;margin:auto}.sig{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:50px}
.sig div{border-top:1px solid #333;padding-top:4px;text-align:center}@media print{.np{display:none}body{margin:10mm}}
</style></head><body>
<p class="np"><button onclick="print()">Imprimir / salvar PDF</button></p>
<h1>${esc(s.company_name)} — Prestação de contas #${rp.id}</h1>
<div class="muted">${esc(rp.title)}</div>
<div class="grid">
<div><b>Colaborador:</b> ${esc(rp.user_name)}</div><div><b>Centro de custo:</b> ${esc(rp.user_cost_center || '—')}</div><div><b>Situação:</b> ${esc(C.REPORT_STATUS[rp.status])}</div>
<div><b>Período:</b> ${d(rp.period_start)} a ${d(rp.period_end)}</div><div><b>Supervisor:</b> ${esc(rp.supervisor_name || '—')}</div><div><b>Enviada em:</b> ${d(rp.submitted_at)}</div>
</div>
<h2>Despesas</h2>
<table><thead><tr><th>#</th><th>Data</th><th>Categoria</th><th>Fornecedor / descrição</th><th>Documento</th><th>Pagamento</th><th class="r">Valor</th></tr></thead><tbody>
${exps.map((e) => `<tr class="${e.status === 'glosada' ? 'g' : ''}"><td>${e.id}</td><td>${d(e.expense_date)}</td><td>${esc(e.category_name)}</td>
<td>${esc(e.supplier_name || '')}${e.supplier_doc ? ` <span class="muted">(${esc(e.supplier_doc)})</span>` : ''}<br><span class="muted">${esc(e.description || '')}</span>${e.status === 'glosada' ? `<br>Glosa: ${esc(e.glosa_reason)}` : ''}</td>
<td>${esc(C.DOC_TYPES[e.doc_type])}${e.doc_number ? ' nº ' + esc(e.doc_number) : ''}</td><td>${esc(C.PAYMENT_METHODS[e.payment_method])}</td><td class="r">${brl(e.amount_cents)}</td></tr>`).join('')}
</tbody><tfoot>
<tr class="tot"><td colspan="6" class="r">Total apresentado</td><td class="r">${brl(rp.total_cents)}</td></tr>
<tr><td colspan="6" class="r">(-) Glosas</td><td class="r">${brl(rp.glosa_cents)}</td></tr>
<tr class="tot"><td colspan="6" class="r">Total aprovado</td><td class="r">${brl(rp.total_cents - rp.glosa_cents)}</td></tr>
<tr><td colspan="6" class="r">(-) Adiantamento recebido${rp.advance_id ? ` #${rp.advance_id}` : ''}</td><td class="r">${brl(Math.round(rp.advance_amount * 100))}</td></tr>
<tr class="tot"><td colspan="6" class="r">${esc(rp.balance_label)}</td><td class="r">${brl(Math.abs(Math.round(rp.balance * 100)))}</td></tr>
</tfoot></table>
<h2>Histórico de aprovação</h2>
<table><thead><tr><th>Data</th><th>Responsável</th><th>Ação</th><th>Situação</th><th>Comentário</th></tr></thead><tbody>
${hist.map((h) => `<tr><td>${d(h.created_at)}</td><td>${esc(h.user_name)} <span class="muted">(${esc(C.ROLES[h.role])})</span></td><td>${esc(h.action.replace(/_/g, ' '))}</td><td>${esc(C.REPORT_STATUS[h.to_status] || '')}</td><td>${esc(h.comment || '')}</td></tr>`).join('')}
</tbody></table>
<div class="sig"><div>${esc(rp.user_name)}<br>Colaborador</div><div>Supervisor</div><div>Gestor</div></div>
${atts.length ? `<h2 style="break-before:page">Comprovantes</h2><div class="recs">${atts.map((a) => `<figure>${a.mime === 'application/pdf'
    ? `<div>Despesa #${a.expense_id}: comprovante em PDF (anexo #${a.id})</div>`
    : `<img src="/api/files/${a.id}" alt="Comprovante da despesa ${a.expense_id}">`}<figcaption class="muted">Despesa #${a.expense_id}</figcaption></figure>`).join('')}</div>` : ''}
</body></html>`);
}));

// ---------- Adiantamentos ----------
const ADV_SELECT = `SELECT a.*, u.name AS user_name, ap.name AS approved_by_name,
  (SELECT r.id FROM reports r WHERE r.advance_id = a.id AND r.status <> 'rejeitada' LIMIT 1) AS report_id,
  (SELECT r.status FROM reports r WHERE r.advance_id = a.id AND r.status <> 'rejeitada' LIMIT 1) AS report_status
  FROM advances a JOIN users u ON u.id = a.user_id LEFT JOIN users ap ON ap.id = a.approved_by`;
const shapeAdv = (a) => a && ({ ...a, amount: C.fromCents(a.amount_cents) });

r.get('/advances', wrap((req, res) => {
  const scope = C.scopeSql(req.user, 'a.user_id');
  const w = [scope.sql]; const p = [...scope.params];
  if (req.query.user_id) { w.push('a.user_id = ?'); p.push(Number(req.query.user_id)); }
  if (req.query.status) { const st = String(req.query.status).split(','); w.push(`a.status IN (${st.map(() => '?').join(',')})`); p.push(...st); }
  if (req.query.available === '1') w.push(`a.status IN ('aprovado','pago') AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.advance_id = a.id AND r.status <> 'rejeitada')`);
  if (req.query.mine === '1') { w.push('a.user_id = ?'); p.push(req.user.id); }
  res.json(all(`${ADV_SELECT} WHERE ${w.join(' AND ')} ORDER BY a.id DESC`, ...p).map(shapeAdv));
}));

r.post('/advances', wrap((req, res) => {
  const b = req.body || {};
  const amount = C.toCents(b.amount);
  if (!amount || amount <= 0) throw bad('Valor inválido');
  if (!b.purpose?.trim()) throw bad('Informe a finalidade');
  let userId = req.user.id; let status = 'solicitado';
  if (isAdmin(req.user) && b.user_id) { userId = Number(b.user_id); status = 'aprovado'; }
  const info = run(`INSERT INTO advances(user_id, amount_cents, purpose, expected_date, status, created_by, approved_by, approved_at, notes)
    VALUES(?,?,?,?,?,?,?,${status === 'aprovado' ? "datetime('now','localtime')" : 'NULL'},?)`,
    userId, amount, b.purpose.trim(), b.expected_date || null, status, req.user.id, status === 'aprovado' ? req.user.id : null, b.notes || null);
  const id = Number(info.lastInsertRowid);
  if (status === 'solicitado') notifyManagers({ type: 'adiantamento', title: `${req.user.name} solicitou adiantamento de ${brl(amount)}`, body: b.purpose, link: '#/adiantamentos' });
  else notify(userId, { type: 'adiantamento', title: `Adiantamento de ${brl(amount)} aprovado para você`, body: b.purpose, link: '#/adiantamentos' });
  res.status(201).json(shapeAdv(one(`${ADV_SELECT} WHERE a.id = ?`, id)));
}));

r.post('/advances/:id/:action', C.requireRole('master', 'gestor'), wrap((req, res) => {
  const a = one('SELECT * FROM advances WHERE id = ?', req.params.id);
  if (!a) throw notFound();
  const { action } = req.params;
  const note = req.body?.notes || null;
  if (action === 'approve') {
    if (a.status !== 'solicitado') throw bad('Somente solicitações podem ser aprovadas');
    run(`UPDATE advances SET status='aprovado', approved_by=?, approved_at=datetime('now','localtime'), notes=COALESCE(?, notes) WHERE id=?`, req.user.id, note, a.id);
  } else if (action === 'reject') {
    if (!['solicitado', 'aprovado'].includes(a.status)) throw bad('Não é possível rejeitar neste status');
    run(`UPDATE advances SET status='rejeitado', approved_by=?, approved_at=datetime('now','localtime'), notes=COALESCE(?, notes) WHERE id=?`, req.user.id, note, a.id);
  } else if (action === 'pay') {
    if (!['aprovado', 'solicitado'].includes(a.status)) throw bad('Adiantamento não está aprovado');
    run(`UPDATE advances SET status='pago', paid_at=datetime('now','localtime'), payment_method=?, approved_by=COALESCE(approved_by, ?), approved_at=COALESCE(approved_at, datetime('now','localtime')), notes=COALESCE(?, notes) WHERE id=?`,
      req.body?.payment_method || 'transferencia', req.user.id, note, a.id);
  } else throw bad('Ação inválida');
  const labels = { approve: 'aprovado', reject: 'rejeitado', pay: 'pago' };
  notify(a.user_id, { type: 'adiantamento', title: `Seu adiantamento #${a.id} de ${brl(a.amount_cents)} foi ${labels[action]}`, body: note, link: '#/adiantamentos' });
  res.json(shapeAdv(one(`${ADV_SELECT} WHERE a.id = ?`, a.id)));
}));

module.exports = r;
module.exports.canActOnReport = canActOnReport;
module.exports.getReport = getReport;
