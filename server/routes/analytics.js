'use strict';
// Relatórios gerenciais e consolidação
const express = require('express');
const { all, one } = require('../db');
const C = require('../common');
const { buildWhere } = require('./expenses');
const { authenticate, requireRole, wrap } = C;

const r = express.Router();
r.use(authenticate);
r.use(requireRole('master', 'gestor', 'supervisor'));

const FROM = `FROM expenses e JOIN users u ON u.id = e.user_id LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN reports rp ON rp.id = e.report_id`;

function group(where, params, keyExpr, labelExpr, order = 'total DESC', limit = 50) {
  return all(`SELECT ${keyExpr} AS key, ${labelExpr} AS label, COUNT(*) AS count, SUM(e.amount_cents) AS total_cents,
      SUM(CASE WHEN e.status = 'glosada' THEN e.amount_cents ELSE 0 END) AS glosa_cents,
      SUM(CASE WHEN e.status = 'aprovada' THEN e.amount_cents ELSE 0 END) AS approved_cents
    ${FROM} WHERE ${where} GROUP BY ${keyExpr} ORDER BY ${order.replace('total', 'SUM(e.amount_cents)')} LIMIT ${limit}`, ...params)
    .map((x) => ({ key: x.key, label: x.label ?? '—', count: x.count, total: C.fromCents(x.total_cents), glosa: C.fromCents(x.glosa_cents), approved: C.fromCents(x.approved_cents) }));
}

r.get('/analytics/summary', wrap((req, res) => {
  const { where, params } = buildWhere(req.user, req.query);
  const k = one(`SELECT COUNT(*) n, COALESCE(SUM(e.amount_cents),0) total,
      COALESCE(SUM(CASE WHEN e.status='aprovada' THEN e.amount_cents END),0) approved,
      COALESCE(SUM(CASE WHEN e.status='em_analise' THEN e.amount_cents END),0) analysis,
      COALESCE(SUM(CASE WHEN e.status='glosada' THEN e.amount_cents END),0) glosa,
      COALESCE(SUM(CASE WHEN e.status='rascunho' THEN e.amount_cents END),0) draft,
      COALESCE(SUM(CASE WHEN COALESCE(e.advance_id, rp.advance_id) IS NOT NULL THEN e.amount_cents END),0) with_advance,
      COUNT(DISTINCT e.user_id) users,
      SUM(CASE WHEN c.limit_cents IS NOT NULL AND e.amount_cents > c.limit_cents THEN 1 ELSE 0 END) over_limit,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM attachments a WHERE a.expense_id = e.id) THEN 1 ELSE 0 END) no_receipt
    ${FROM} WHERE ${where}`, ...params);

  const scope = C.scopeSql(req.user, 'r.user_id');
  const pending = one(`SELECT COUNT(*) n, COALESCE(SUM((SELECT SUM(amount_cents) FROM expenses x WHERE x.report_id = r.id)),0) total
    FROM reports r JOIN users u ON u.id = r.user_id WHERE ${scope.sql} AND r.status IN ('aguardando_supervisor','aguardando_gestor')`, ...scope.params);
  const toPay = one(`SELECT COUNT(*) n FROM reports r JOIN users u ON u.id = r.user_id WHERE ${scope.sql} AND r.status = 'aprovada'`, ...scope.params);
  const advScope = C.scopeSql(req.user, 'a.user_id');
  const adv = one(`SELECT COALESCE(SUM(CASE WHEN a.status='pago' THEN a.amount_cents END),0) open_paid,
      COUNT(CASE WHEN a.status='solicitado' THEN 1 END) requested
    FROM advances a WHERE ${advScope.sql}`, ...advScope.params);

  res.json({
    kpis: {
      count: k.n, total: C.fromCents(k.total), average: k.n ? C.fromCents(Math.round(k.total / k.n)) : 0,
      approved: C.fromCents(k.approved), in_analysis: C.fromCents(k.analysis), glosa: C.fromCents(k.glosa), draft: C.fromCents(k.draft),
      with_advance: C.fromCents(k.with_advance), users: k.users, over_limit: k.over_limit || 0, no_receipt: k.no_receipt || 0,
      reports_pending: pending.n, reports_pending_total: C.fromCents(pending.total), reports_to_pay: toPay.n,
      advances_open: C.fromCents(adv.open_paid), advances_requested: adv.requested,
    },
    by_category: group(where, params, 'e.category_id', 'c.name'),
    by_user: group(where, params, 'e.user_id', 'u.name'),
    by_month: group(where, params, "substr(e.expense_date,1,7)", "substr(e.expense_date,1,7)", 'key ASC', 36),
    by_payment: group(where, params, 'e.payment_method', 'e.payment_method').map((x) => ({ ...x, label: C.PAYMENT_METHODS[x.key] || x.key })),
    by_doc_type: group(where, params, 'e.doc_type', 'e.doc_type').map((x) => ({ ...x, label: C.DOC_TYPES[x.key] || x.key })),
    by_cost_center: group(where, params, "COALESCE(e.cost_center,'(sem centro de custo)')", "COALESCE(e.cost_center,'(sem centro de custo)')"),
    by_status: group(where, params, 'e.status', 'e.status').map((x) => ({ ...x, label: C.EXPENSE_STATUS[x.key] || x.key })),
    by_advance: group(where, params, "CASE WHEN COALESCE(e.advance_id, rp.advance_id) IS NULL THEN 'nao' ELSE 'sim' END",
      "CASE WHEN COALESCE(e.advance_id, rp.advance_id) IS NULL THEN 'Sem adiantamento' ELSE 'Com adiantamento' END"),
    top_suppliers: group(where, params, "COALESCE(NULLIF(e.supplier_doc,''), e.supplier_name)", 'MAX(e.supplier_name)', 'total DESC', 15),
  });
}));

// Matriz colaborador x categoria (consolidação)
r.get('/analytics/matrix', wrap((req, res) => {
  const { where, params } = buildWhere(req.user, req.query);
  const rows = all(`SELECT u.id uid, u.name uname, c.name cname, SUM(e.amount_cents) t ${FROM} WHERE ${where} GROUP BY u.id, c.id ORDER BY u.name`, ...params);
  const cats = [...new Set(rows.map((x) => x.cname || '—'))].sort();
  const users = {};
  for (const x of rows) {
    users[x.uid] ??= { user: x.uname, values: {}, total: 0 };
    users[x.uid].values[x.cname || '—'] = C.fromCents(x.t);
    users[x.uid].total += x.t;
  }
  res.json({ categories: cats, rows: Object.values(users).map((u) => ({ ...u, total: C.fromCents(u.total) })).sort((a, b) => b.total - a.total) });
}));

// Saldo de adiantamentos por colaborador
r.get('/analytics/advances', wrap((req, res) => {
  const scope = C.scopeSql(req.user, 'a.user_id');
  const rows = all(`SELECT u.id, u.name,
      COALESCE(SUM(CASE WHEN a.status IN ('pago','liquidado') THEN a.amount_cents END),0) paid,
      COALESCE(SUM(CASE WHEN a.status = 'pago' THEN a.amount_cents END),0) open,
      COALESCE(SUM(CASE WHEN a.status = 'liquidado' THEN a.amount_cents END),0) settled,
      COUNT(*) n
    FROM advances a JOIN users u ON u.id = a.user_id WHERE ${scope.sql} AND a.status <> 'rejeitado' GROUP BY u.id ORDER BY open DESC`, ...scope.params);
  res.json(rows.map((x) => ({ user_id: x.id, user: x.name, count: x.n, paid: C.fromCents(x.paid), open: C.fromCents(x.open), settled: C.fromCents(x.settled) })));
}));

// Tempo médio de aprovação (SLA) por etapa
r.get('/analytics/approvals', wrap((req, res) => {
  const scope = C.scopeSql(req.user, 'r.user_id');
  const q = req.query;
  const w = [scope.sql]; const p = [...scope.params];
  if (q.date_from) { w.push('date(r.submitted_at) >= ?'); p.push(q.date_from); }
  if (q.date_to) { w.push('date(r.submitted_at) <= ?'); p.push(q.date_to); }
  const x = one(`SELECT
      AVG(CASE WHEN r.supervisor_approved_at IS NOT NULL THEN julianday(r.supervisor_approved_at) - julianday(r.submitted_at) END) sup_days,
      AVG(CASE WHEN r.approved_at IS NOT NULL THEN julianday(r.approved_at) - julianday(r.submitted_at) END) total_days,
      AVG(CASE WHEN r.finalized_at IS NOT NULL THEN julianday(r.finalized_at) - julianday(r.approved_at) END) pay_days,
      COUNT(*) n
    FROM reports r JOIN users u ON u.id = r.user_id WHERE ${w.join(' AND ')} AND r.submitted_at IS NOT NULL`, ...p);
  const byStatus = all(`SELECT r.status, COUNT(*) n FROM reports r JOIN users u ON u.id = r.user_id WHERE ${w.join(' AND ')} GROUP BY r.status`, ...p)
    .map((s) => ({ status: s.status, label: C.REPORT_STATUS[s.status], count: s.n }));
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  res.json({ submitted: x.n, supervisor_days: round(x.sup_days), approval_days: round(x.total_days), payment_days: round(x.pay_days), by_status: byStatus });
}));

module.exports = r;
