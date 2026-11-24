'use strict';
const { all, one, run } = require('../db');
const { EXPENSE_FIELDS, PAYMENT_METHODS, DOC_TYPES, ROLES, brl } = require('../common');

function notify(userId, { type, title, body = null, link = null, data = null }) {
  run('INSERT INTO notifications(user_id, type, title, body, link, data) VALUES(?,?,?,?,?,?)',
    userId, type, title, body, link, data ? JSON.stringify(data) : null);
}

// Gestores ativos (se não houver nenhum, os masters recebem)
function managerIds() {
  let ids = all(`SELECT id FROM users WHERE role = 'gestor' AND active = 1`).map((r) => r.id);
  if (!ids.length) ids = all(`SELECT id FROM users WHERE role = 'master' AND active = 1`).map((r) => r.id);
  return ids;
}

function notifyManagers(payload, exceptId = null) {
  const ids = managerIds().filter((id) => id !== exceptId);
  for (const id of ids) notify(id, payload);
  return ids.length;
}

// Converte um valor bruto de campo de despesa em texto legível
function displayValue(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  switch (field) {
    case 'amount_cents': return brl(v);
    case 'category_id': { const c = one('SELECT name FROM categories WHERE id = ?', v); return c ? c.name : `#${v}`; }
    case 'payment_method': return PAYMENT_METHODS[v] || v;
    case 'doc_type': return DOC_TYPES[v] || v;
    case 'expense_date': return v.split('-').reverse().join('/');
    case 'advance_id': return `Adiantamento #${v}`;
    default: return String(v);
  }
}

// Calcula a lista de alterações entre duas versões de uma despesa
function diffExpense(before, after) {
  const changes = [];
  for (const [field, label] of Object.entries(EXPENSE_FIELDS)) {
    const b = before[field] ?? null;
    const a = after[field] ?? null;
    if (String(b ?? '') !== String(a ?? '')) {
      changes.push({ field, label, before: displayValue(field, b), after: displayValue(field, a) });
    }
  }
  return changes;
}

module.exports = { notify, notifyManagers, managerIds, diffExpense, displayValue, ROLES };
