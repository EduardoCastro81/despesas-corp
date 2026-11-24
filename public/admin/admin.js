import {
  $, $$, esc, brl, dt, dtt, today, monthStart, fmtDoc, api, qs, session, toast, fail, modal, prompt, confirmBox, download,
  reportBadge, expBadge, advBadge, expFlags, optionList, catOptions, receiptViewer, editsHtml, expenseForm, openExpenseEdit,
  bootstrap, loginScreen,
} from '/shared/core.js';

const root = $('#root');
const isAdmin = () => ['master', 'gestor'].includes(session.me.role);
let users = [];
let unread = 0;
let pendingApprovals = 0;

// ---------- Inicialização ----------
async function start() {
  if (!session.token) return showLogin();
  try { await bootstrap(); } catch { return showLogin(); }
  if (session.me.role === 'colaborador') {
    root.innerHTML = `<div class="login-wrap"><div class="card login-card stack"><h1>Acesso restrito</h1>
      <p>A plataforma de administração é destinada a administradores, gestores e supervisores. Use a plataforma de lançamento para registrar suas despesas.</p>
      <a class="btn primary" href="/app/">Ir para lançamento de despesas</a><button class="btn" id="lo">Sair</button></div></div>`;
    $('#lo').onclick = logout;
    return;
  }
  users = await api('/users');
  shell();
  window.addEventListener('hashchange', route);
  route();
  setInterval(refreshCounters, 60000);
}
function showLogin() {
  loginScreen(root, { title: 'Plataforma de administração', subtitle: 'Conferência, aprovação e análise de despesas', onLogin: () => start() });
}
function logout() { session.clear(); location.hash = ''; location.reload(); }

const NAV = [
  { sec: 'Operação' },
  { h: 'dashboard', label: 'Painel', roles: ['master', 'gestor', 'supervisor'] },
  { h: 'conferencia', label: 'Conferência de despesas', roles: ['master', 'gestor', 'supervisor'] },
  { h: 'prestacoes', label: 'Prestações de contas', roles: ['master', 'gestor', 'supervisor'], badge: () => pendingApprovals },
  { h: 'adiantamentos', label: 'Adiantamentos', roles: ['master', 'gestor', 'supervisor'] },
  { sec: 'Análise' },
  { h: 'relatorios', label: 'Relatórios gerenciais', roles: ['master', 'gestor', 'supervisor'] },
  { h: 'auditoria', label: 'Auditoria de edições', roles: ['master', 'gestor', 'supervisor'] },
  { h: 'notificacoes', label: 'Notificações', roles: ['master', 'gestor', 'supervisor'], badge: () => unread },
  { sec: 'Cadastros' },
  { h: 'usuarios', label: 'Usuários e equipes', roles: ['master', 'gestor', 'supervisor'] },
  { h: 'categorias', label: 'Categorias e limites', roles: ['master', 'gestor'] },
  { h: 'config', label: 'Configurações', roles: ['master', 'gestor'] },
];

function shell() {
  root.innerHTML = `<div class="layout">
    <aside class="side" id="side">
      <div class="brand"><span class="logo">R$</span><div>Despesas Corp<div class="muted small" style="font-weight:400">${esc(session.meta.company_name)}</div></div></div>
      <nav id="nav"></nav>
      <div class="who"><strong>${esc(session.me.name)}</strong><div class="muted">${esc(session.meta.roles[session.me.role])}</div>
        <div class="row" style="margin-top:.5rem"><a class="btn sm" href="/app/">Lançar despesa</a><button class="btn sm" id="pw">Senha</button><button class="btn sm" id="lo">Sair</button></div></div>
    </aside>
    <main class="main"><div id="page"></div></main></div>`;
  $('#lo').onclick = logout;
  $('#pw').onclick = changePassword;
  renderNav();
  refreshCounters();
}
function renderNav() {
  const cur = (location.hash.slice(2).split('/')[0]) || 'dashboard';
  $('#nav').innerHTML = NAV.filter((n) => n.sec || n.roles.includes(session.me.role)).map((n) => n.sec
    ? `<div class="sec">${n.sec}</div>`
    : `<a href="#/${n.h}" class="${cur === n.h || (cur === 'prestacao' && n.h === 'prestacoes') ? 'on' : ''}">${n.label}${n.badge && n.badge() ? `<span class="count">${n.badge()}</span>` : ''}</a>`).join('');
}
async function refreshCounters() {
  try {
    const [n, p] = await Promise.all([api('/notifications?unread=1'), api('/reports?pending_me=1')]);
    unread = n.unread; pendingApprovals = p.length;
    renderNav();
  } catch { /* ignora */ }
}
function changePassword() {
  modal({
    title: 'Alterar senha', body: `<div class="stack"><label class="f">Senha atual<input type="password" id="pc"></label><label class="f">Nova senha<input type="password" id="pn"></label></div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async ({ el }) => { await api('/me/password', { method: 'POST', body: { current: $('#pc', el).value, password: $('#pn', el).value } }); toast('Senha alterada', 'good'); } }],
  });
}

const PAGES = {};
async function route() {
  const [name, arg] = location.hash.slice(2).split('/');
  const page = $('#page');
  $('#side')?.classList.remove('open');
  renderNav();
  page.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  const fn = PAGES[name || 'dashboard'] || PAGES.dashboard;
  try { await fn(page, arg); } catch (e) { page.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
const head = (title, sub, actions = '') => `<div class="page-head"><div class="row"><button class="btn sm menu-toggle" onclick="document.getElementById('side').classList.toggle('open')" aria-label="Menu">☰</button><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div></div><div class="row">${actions}</div></div>`;

// ---------- Filtros reutilizáveis ----------
const FILTER_KEY = 'dc_admin_filters';
function loadFilters() {
  try { return JSON.parse(sessionStorage.getItem(FILTER_KEY)) || null; } catch { return null; }
}
let filters = loadFilters() || { date_from: monthStart(-2), date_to: today() };
function saveFilters() { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* ignora */ } }

function filterBar(onApply, { compact = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  const sel = (n, opts) => `<select name="${n}">${opts}</select>`;
  const userOpts = `<option value="">Todos</option>${users.filter((u) => u.role !== 'master' || isAdmin()).map((u) => `<option value="${u.id}" ${String(filters.user_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}${u.active ? '' : ' (inativo)'}</option>`).join('')}`;
  const supOpts = `<option value="">Todos</option>${users.filter((u) => u.role === 'supervisor').map((u) => `<option value="${u.id}" ${String(filters.supervisor_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}`;
  el.innerHTML = `<form class="filters">
    <label class="f">De<input type="date" name="date_from" value="${esc(filters.date_from || '')}"></label>
    <label class="f">Até<input type="date" name="date_to" value="${esc(filters.date_to || '')}"></label>
    <label class="f">Usuário${sel('user_id', userOpts)}</label>
    ${isAdmin() ? `<label class="f">Equipe (supervisor)${sel('supervisor_id', supOpts)}</label>` : ''}
    <label class="f">Categoria${sel('category_id', catOptions(filters.category_id, 'Todas', true))}</label>
    <label class="f">Forma de pagamento${sel('payment_method', optionList(session.meta.payment_methods, filters.payment_method, 'Todas'))}</label>
    <label class="f">Adiantamento${sel('has_advance', optionList({ 1: 'Com adiantamento', 0: 'Sem adiantamento' }, filters.has_advance, 'Todos'))}</label>
    ${compact ? '' : `
    <label class="f">Situação da despesa${sel('status', optionList(session.meta.expense_status, filters.status, 'Todas'))}</label>
    <label class="f">Tipo de documento${sel('doc_type', optionList(session.meta.doc_types, filters.doc_type, 'Todos'))}</label>
    <label class="f">Alertas${sel('flag', optionList({ any: 'Qualquer alerta', over_limit: 'Acima do limite', duplicate: 'Possível duplicidade' }, filters.flag, 'Sem filtro'))}</label>
    <label class="f">Edições${sel('edited', optionList({ 1: 'Somente editadas' }, filters.edited, 'Todas'))}</label>
    <label class="f">Busca<input name="q" placeholder="Fornecedor, nº, CNPJ..." value="${esc(filters.q || '')}"></label>`}
    <div class="actions"><button class="btn primary">Filtrar</button><button class="btn" type="button" data-clear>Limpar</button></div>
  </form>`;
  const form = $('form', el);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    filters = Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== ''));
    saveFilters(); onApply();
  };
  $('[data-clear]', el).onclick = () => { filters = { date_from: monthStart(-2), date_to: today() }; saveFilters(); onApply(true); };
  return el;
}

// ---------- Gráficos ----------
function hbars(rows, { value = 'total', fmt = brl, limit = 10 } = {}) {
  const list = rows.slice(0, limit);
  if (!list.length) return '<div class="empty">Sem dados no período</div>';
  const max = Math.max(...list.map((r) => r[value]), 1);
  const rest = rows.slice(limit);
  const restTotal = rest.reduce((s, r) => s + r[value], 0);
  return `<div class="bars">${list.map((r) => `<div class="bar-row" title="${esc(r.label)}: ${fmt(r[value])} — ${r.count} lançamento(s)">
      <span class="lbl">${esc(r.label)}</span><span class="track"><span class="fill" style="display:block;width:${(r[value] / max) * 100}%"></span></span><span class="v">${fmt(r[value])}</span></div>`).join('')}
    ${rest.length ? `<div class="muted small">+ ${rest.length} outros: ${fmt(restTotal)}</div>` : ''}</div>`;
}
const charts = [];
function lineChart(canvas, rows) {
  if (!window.Chart) return;
  while (charts.length) charts.pop().destroy();
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--series-1').trim();
  const grid = css.getPropertyValue('--border').trim();
  const ink = css.getPropertyValue('--text-2').trim();
  const labels = rows.map((r) => { const [y, m] = r.key.split('-'); return `${m}/${y}`; });
  charts.push(new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Total de despesas', data: rows.map((r) => r.total), borderColor: c1, backgroundColor: c1, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${brl(ctx.parsed.y)} (${rows[ctx.dataIndex].count} lançamentos)` } } },
      scales: { x: { grid: { display: false }, ticks: { color: ink } }, y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink, callback: (v) => brl(v).replace(',00', '') } } },
    },
  }));
}

// ---------- Painel ----------
PAGES.dashboard = async (page) => {
  page.innerHTML = head('Painel', session.me.role === 'supervisor' ? 'Visão consolidada do seu time' : 'Visão consolidada da empresa');
  const fb = filterBar(() => PAGES.dashboard(page), { compact: true });
  page.append(fb);
  const box = document.createElement('div');
  page.append(box);
  const [s, pend] = await Promise.all([api(`/analytics/summary${qs(filters)}`), api('/reports?pending_me=1')]);
  const k = s.kpis;
  box.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">Total lançado</div><div class="value">${brl(k.total)}</div><div class="sub">${k.count} lançamentos · ${k.users} usuários</div></div>
      <div class="kpi"><div class="label">Aprovado</div><div class="value">${brl(k.approved)}</div><div class="sub">Em análise: ${brl(k.in_analysis)}</div></div>
      <div class="kpi"><div class="label">Glosado</div><div class="value">${brl(k.glosa)}</div><div class="sub">Rascunho: ${brl(k.draft)}</div></div>
      <div class="kpi"><div class="label">Ticket médio</div><div class="value">${brl(k.average)}</div><div class="sub">Com adiantamento: ${brl(k.with_advance)}</div></div>
      <div class="kpi"><div class="label">Prestações pendentes</div><div class="value">${k.reports_pending}</div><div class="sub">${brl(k.reports_pending_total)} · ${k.reports_to_pay} a pagar</div></div>
      <div class="kpi"><div class="label">Adiantamentos em aberto</div><div class="value">${brl(k.advances_open)}</div><div class="sub">${k.advances_requested} solicitação(ões)</div></div>
      <div class="kpi"><div class="label">Alertas</div><div class="value">${k.over_limit + k.no_receipt}</div><div class="sub">${k.over_limit} acima do limite · ${k.no_receipt} sem comprovante</div></div>
    </div>
    ${pend.length ? `<div class="card" style="margin-top:1rem"><div class="row between"><h2>Aguardando sua aprovação</h2><a href="#/prestacoes">Ver todas</a></div>${reportsTable(pend.slice(0, 6))}</div>` : ''}
    <div class="grid2" style="margin-top:1rem">
      <div class="card"><h2>Evolução mensal</h2><div class="chart-box"><canvas id="ch-month" aria-label="Total de despesas por mês"></canvas></div></div>
      <div class="card"><h2>Por categoria</h2>${hbars(s.by_category)}</div>
      <div class="card"><h2>Por usuário</h2>${hbars(s.by_user)}</div>
      <div class="card"><h2>Por forma de pagamento</h2>${hbars(s.by_payment)}</div>
    </div>`;
  lineChart($('#ch-month', box), s.by_month);
  bindReportRows(box);
};

// ---------- Conferência de despesas ----------
PAGES.conferencia = async (page) => {
  page.innerHTML = head('Conferência de despesas', 'Filtre, visualize comprovantes, edite e analise os lançamentos',
    `${isAdmin() ? '<button class="btn" id="new-exp">+ Lançar despesa</button>' : ''}<button class="btn" id="ex-csv">Exportar CSV</button><button class="btn" id="ex-xlsx">Exportar Excel</button>`);
  const list = document.createElement('div');
  page.append(filterBar(() => load()), list);
  $('#ex-csv').onclick = () => download(`/expenses/export${qs({ ...filters, format: 'csv' })}`, `despesas-${today()}.csv`).catch(fail);
  $('#ex-xlsx').onclick = () => download(`/expenses/export${qs({ ...filters, format: 'xlsx' })}`, `despesas-${today()}.xlsx`).catch(fail);
  const nb = $('#new-exp'); if (nb) nb.onclick = () => newExpenseForOther(load);
  async function load() {
    list.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    const r = await api(`/expenses${qs(filters)}`);
    list.innerHTML = `<div class="row between" style="margin:.25rem 0 .6rem"><span class="muted">${r.count} lançamento(s)</span><strong>Total: ${brl(r.total)}</strong></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Data</th><th>Usuário</th><th>Categoria</th><th>Fornecedor</th><th>Documento</th><th>Pagamento</th><th class="num">Valor</th><th>Situação</th><th>Prestação</th><th>Alertas</th></tr></thead>
    <tbody>${r.items.map((e) => `<tr class="clickable" data-id="${e.id}"><td>${e.id}</td><td>${dt(e.expense_date)}</td><td>${esc(e.user_name)}</td><td>${esc(e.category_name || '—')}</td>
      <td>${esc(e.supplier_name || '—')}<div class="muted small">${esc(fmtDoc(e.supplier_doc || ''))}</div></td><td>${esc(session.meta.doc_types[e.doc_type])}${e.doc_number ? `<div class="muted small">nº ${esc(e.doc_number)}</div>` : ''}</td>
      <td>${esc(session.meta.payment_methods[e.payment_method])}</td><td class="num">${brl(e.amount)}</td><td>${expBadge(e.status)}</td>
      <td>${e.report_id ? `<a href="#/prestacao/${e.report_id}" onclick="event.stopPropagation()">#${e.report_id}</a> ${reportBadge(e.report_status)}` : '<span class="muted">—</span>'}</td><td>${expFlags(e)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">Nenhuma despesa encontrada</td></tr>'}</tbody>
    </table></div>`;
    $$('tr[data-id]', list).forEach((tr) => (tr.onclick = () => expenseDetail(Number(tr.dataset.id), load)));
  }
  await load();
};

async function newExpenseForOther(onSaved) {
  const active = users.filter((u) => u.active);
  const form = expenseForm({ users: active });
  modal({
    title: 'Lançar despesa (gestor)', body: form, wide: true, actions: [
      { label: 'Cancelar' },
      { label: 'Salvar', kind: 'primary', onClick: async () => { const d = form.validate(); if (!d) return false; await api('/expenses', { method: 'POST', body: d }); toast('Despesa lançada', 'good'); onSaved?.(); } },
    ],
  });
}

async function expenseDetail(id, onChange) {
  const e = await api(`/expenses/${id}`);
  const body = document.createElement('div');
  body.innerHTML = `<div class="detail-grid"><div data-v></div><div class="stack">
    <div class="row">${expBadge(e.status)} ${expFlags(e)}</div>
    ${e.status === 'glosada' && e.glosa_reason ? `<div class="alert bad"><b>Glosa:</b> ${esc(e.glosa_reason)}</div>` : ''}
    <dl class="kv">
      <dt>Usuário</dt><dd>${esc(e.user_name)}</dd>
      <dt>Data</dt><dd>${dt(e.expense_date)}</dd>
      <dt>Valor</dt><dd><strong>${brl(e.amount)}</strong>${e.over_limit ? ` <span class="badge warn">limite da categoria: ${brl(e.category_limit)}</span>` : ''}</dd>
      <dt>Categoria</dt><dd>${esc(e.category_name || '—')}</dd>
      <dt>Forma de pagamento</dt><dd>${esc(session.meta.payment_methods[e.payment_method])}</dd>
      <dt>Documento</dt><dd>${esc(session.meta.doc_types[e.doc_type])} ${e.doc_number ? `nº ${esc(e.doc_number)}` : ''}</dd>
      <dt>Fornecedor</dt><dd>${esc(e.supplier_name || '—')} ${e.supplier_doc ? `<div class="muted">${esc(fmtDoc(e.supplier_doc))}</div>` : ''}</dd>
      <dt>Cidade</dt><dd>${esc(e.city || '—')}</dd>
      <dt>Centro de custo</dt><dd>${esc(e.cost_center || '—')}</dd>
      <dt>Chave de acesso</dt><dd class="small">${esc(e.access_key || '—')}</dd>
      <dt>Descrição</dt><dd>${esc(e.description || '—')}</dd>
      <dt>Adiantamento</dt><dd>${e.linked_advance_id ? `Sim (#${e.linked_advance_id})` : 'Não'}</dd>
      <dt>Prestação</dt><dd>${e.report_id ? `<a href="#/prestacao/${e.report_id}">#${e.report_id} ${esc(e.report_title)}</a> ${reportBadge(e.report_status)}` : '—'}</dd>
      <dt>Lançada em</dt><dd>${dtt(e.created_at)}</dd>
    </dl>
    ${e.ocr_data ? `<details><summary class="small">Dados lidos automaticamente do comprovante</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(e.ocr_data, null, 2))}</pre></details>` : ''}
    <div><h3>Histórico de edições</h3>${editsHtml(e.edits)}</div>
  </div></div>`;
  $('[data-v]', body).append(receiptViewer(e.attachments));
  const actions = [{ label: 'Fechar' }];
  if (e.can_edit) actions.unshift({ label: 'Editar', kind: 'primary', onClick: async ({ close }) => { close(); openExpenseEdit(e.id, { onSaved: onChange }); return false; } });
  if (e.report_id && ['aguardando_supervisor', 'aguardando_gestor'].includes(e.report_status)) {
    actions.unshift(e.status === 'glosada'
      ? { label: 'Remover glosa', onClick: async () => { await api(`/expenses/${e.id}/review`, { method: 'POST', body: { action: 'restaurar' } }); toast('Glosa removida', 'good'); onChange?.(); } }
      : { label: 'Glosar', kind: 'danger', onClick: async () => { const reason = await prompt({ title: 'Glosar despesa', label: 'Motivo da glosa' }); if (!reason) return false; await api(`/expenses/${e.id}/review`, { method: 'POST', body: { action: 'glosar', reason } }); toast('Despesa glosada', 'good'); onChange?.(); } });
  }
  if (isAdmin()) actions.unshift({ label: 'Excluir', kind: 'danger', onClick: async () => { const reason = await prompt({ title: 'Excluir despesa', label: 'Justificativa', okLabel: 'Excluir', kind: 'danger solid' }); if (!reason) return false; await api(`/expenses/${e.id}`, { method: 'DELETE', body: { reason } }); toast('Despesa excluída', 'good'); onChange?.(); } });
  modal({ title: `Despesa #${e.id}`, body, wide: true, actions });
}

// ---------- Prestações de contas ----------
function reportsTable(rows) {
  return `<div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Título</th><th>Colaborador</th><th>Período</th><th class="num">Itens</th><th class="num">Total</th><th class="num">Glosas</th><th class="num">Adiant.</th><th class="num">Saldo</th><th>Situação</th><th>Atualizada</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="clickable" data-rid="${r.id}"><td>${r.id}</td><td>${esc(r.title)}${r.can_act ? ' <span class="badge warn">sua aprovação</span>' : ''}</td><td>${esc(r.user_name)}</td><td>${dt(r.period_start)} – ${dt(r.period_end)}</td>
    <td class="num">${r.expense_count}</td><td class="num">${brl(r.total)}</td><td class="num">${r.glosa ? brl(r.glosa) : '—'}</td><td class="num">${r.advance_id ? brl(r.advance_cents / 100) : '—'}</td>
    <td class="num" title="${esc(r.balance_label)}">${brl(r.balance)}</td><td>${reportBadge(r.status)}</td><td>${dtt(r.updated_at)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">Nenhuma prestação</td></tr>'}
  </tbody></table></div>`;
}
const bindReportRows = (el) => $$('tr[data-rid]', el).forEach((tr) => (tr.onclick = () => (location.hash = `#/prestacao/${tr.dataset.rid}`)));

let reportTab = 'pending';
PAGES.prestacoes = async (page) => {
  page.innerHTML = head('Prestações de contas', 'Rotina de aprovação: colaborador → supervisor → gestor → pagamento/liquidação');
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const T = { pending: 'Aguardando minha aprovação', open: 'Em aprovação', approved: 'Aprovadas (a pagar)', all: 'Todas' };
  tabs.innerHTML = Object.entries(T).map(([k, v]) => `<button data-t="${k}" class="${reportTab === k ? 'on' : ''}">${v}</button>`).join('');
  const fl = document.createElement('div');
  fl.className = 'card';
  fl.innerHTML = `<form class="filters"><label class="f">Colaborador<select name="user_id"><option value="">Todos</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
    <label class="f">Situação<select name="status">${optionList(session.meta.report_status, '', 'Todas')}</select></label>
    <label class="f">De<input type="date" name="date_from"></label><label class="f">Até<input type="date" name="date_to"></label>
    <label class="f">Adiantamento<select name="has_advance">${optionList({ 1: 'Com adiantamento', 0: 'Sem adiantamento' }, '', 'Todos')}</select></label>
    <div class="actions"><button class="btn primary">Filtrar</button></div></form>`;
  const list = document.createElement('div');
  list.style.marginTop = '1rem';
  page.append(tabs, fl, list);
  const load = async () => {
    const f = Object.fromEntries([...new FormData($('form', fl))].filter(([, v]) => v));
    if (reportTab === 'pending') f.pending_me = 1;
    if (reportTab === 'open' && !f.status) f.status = 'aguardando_supervisor,aguardando_gestor';
    if (reportTab === 'approved' && !f.status) f.status = 'aprovada';
    const rows = await api(`/reports${qs(f)}`);
    list.innerHTML = reportsTable(rows);
    bindReportRows(list);
  };
  $$('[data-t]', tabs).forEach((b) => (b.onclick = () => { reportTab = b.dataset.t; PAGES.prestacoes(page); }));
  $('form', fl).onsubmit = (ev) => { ev.preventDefault(); load(); };
  await load();
};

PAGES.prestacao = async (page, id) => {
  const r = await api(`/reports/${id}`);
  const actions = [];
  if (r.can_act) actions.push('<button class="btn good" id="ap">Aprovar</button><button class="btn" id="dv">Devolver p/ ajuste</button><button class="btn danger" id="rj">Rejeitar</button>');
  if (r.can_finalize) actions.push('<button class="btn primary" id="fz">Registrar pagamento / liquidação</button>');
  actions.push('<button class="btn" id="pr">Imprimir / PDF</button>');
  page.innerHTML = head(`Prestação #${r.id} — ${r.title}`, `${esc(r.user_name)} · ${dt(r.period_start)} a ${dt(r.period_end)} · ${reportBadge(r.status)}`, actions.join(''));
  const body = document.createElement('div');
  body.innerHTML = `
    ${r.last_comment && ['devolvida', 'rejeitada'].includes(r.status) ? `<div class="alert bad" style="margin-bottom:1rem"><b>Último comentário:</b> ${esc(r.last_comment)}</div>` : ''}
    <div class="totals">
      <div class="kpi"><div class="label">Total apresentado</div><div class="value">${brl(r.total)}</div><div class="sub">${r.expense_count} despesa(s)</div></div>
      <div class="kpi"><div class="label">Glosas</div><div class="value">${brl(r.glosa)}</div></div>
      <div class="kpi"><div class="label">Total aprovado</div><div class="value">${brl(r.approved_total)}</div></div>
      <div class="kpi"><div class="label">Adiantamento${r.advance_id ? ` #${r.advance_id}` : ''}</div><div class="value">${brl(r.advance_amount)}</div><div class="sub">${r.advance_id ? esc(r.advance_purpose || '') + ' · ' + advBadge(r.advance_status) : 'sem adiantamento'}</div></div>
      <div class="kpi"><div class="label">${esc(r.balance_label)}</div><div class="value">${brl(Math.abs(r.balance))}</div></div>
    </div>
    <div class="detail-grid" style="margin-top:1rem">
      <div class="card"><h2>Despesas</h2><div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Data</th><th>Categoria</th><th>Fornecedor</th><th>Pagamento</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
        ${r.expenses.map((e) => `<tr class="clickable" data-eid="${e.id}"><td>${e.id}</td><td>${dt(e.expense_date)}</td><td>${esc(e.category_name)}</td><td>${esc(e.supplier_name || '—')}</td><td>${esc(session.meta.payment_methods[e.payment_method])}</td>
          <td class="num">${brl(e.amount)}</td><td>${expBadge(e.status)}</td><td>${expFlags(e)}</td></tr>`).join('')}
        </tbody></table></div><p class="muted small">Clique em uma despesa para ver o comprovante${r.can_act ? ', editar ou glosar' : ''}.</p></div>
      <div class="stack">
        <div class="card" data-preview><h2>Comprovante</h2><div class="muted">Selecione uma despesa</div></div>
        <div class="card"><h2>Por categoria</h2>${hbars(Object.entries(r.by_category).map(([label, total]) => ({ label, total, count: r.expenses.filter((e) => e.category_name === label).length })).sort((a, b) => b.total - a.total), { limit: 20 })}</div>
        <div class="card"><h2>Histórico de aprovação</h2><ul class="timeline">${r.history.map((h) => `<li><strong>${esc(h.action.replace(/_/g, ' '))}</strong> — ${esc(h.user_name)} <span class="muted small">(${esc(session.meta.roles[h.user_role])})</span><div class="muted small">${dtt(h.created_at)} ${h.to_status ? '→ ' + esc(session.meta.report_status[h.to_status]) : ''}</div>${h.comment ? `<div>${esc(h.comment)}</div>` : ''}</li>`).join('')}</ul></div>
      </div>
    </div>`;
  page.append(body);
  const reload = () => PAGES.prestacao(page, id);
  const preview = $('[data-preview]', body);
  $$('tr[data-eid]', body).forEach((tr) => (tr.onclick = async () => {
    $$('tr[data-eid]', body).forEach((x) => x.classList.toggle('selected', x === tr));
    const e = await api(`/expenses/${tr.dataset.eid}`);
    preview.innerHTML = `<div class="row between"><h2>Despesa #${e.id} — ${brl(e.amount)}</h2><div class="row"><button class="btn sm" data-open>Detalhes</button>${e.can_edit ? '<button class="btn sm" data-edit>Editar</button>' : ''}${r.can_act ? (e.status === 'glosada' ? '<button class="btn sm" data-unglosa>Remover glosa</button>' : '<button class="btn sm danger" data-glosa>Glosar</button>') : ''}</div></div>
      <div class="muted small" style="margin-bottom:.5rem">${esc(e.supplier_name || '')} · ${esc(session.meta.doc_types[e.doc_type])} ${esc(e.doc_number || '')} · ${esc(e.description || '')}</div>`;
    preview.append(receiptViewer(e.attachments));
    $('[data-open]', preview).onclick = () => expenseDetail(e.id, reload);
    const ed = $('[data-edit]', preview); if (ed) ed.onclick = () => openExpenseEdit(e.id, { onSaved: reload });
    const gl = $('[data-glosa]', preview); if (gl) gl.onclick = async () => { const reason = await prompt({ title: 'Glosar despesa', label: 'Motivo da glosa' }); if (!reason) return; await api(`/expenses/${e.id}/review`, { method: 'POST', body: { action: 'glosar', reason } }).then(reload, fail); };
    const ug = $('[data-unglosa]', preview); if (ug) ug.onclick = () => api(`/expenses/${e.id}/review`, { method: 'POST', body: { action: 'restaurar' } }).then(reload, fail);
  }));
  $('#pr').onclick = () => window.open(`/api/reports/${r.id}/print?token=${encodeURIComponent(session.token)}`, '_blank');
  const act = async (path, body, msg) => { await api(`/reports/${r.id}/${path}`, { method: 'POST', body }); toast(msg, 'good'); refreshCounters(); reload(); };
  if (r.can_act) {
    $('#ap').onclick = async () => {
      const c = await prompt({ title: 'Aprovar prestação', label: 'Comentário (opcional)', required: false, okLabel: 'Aprovar', kind: 'good', extra: `<p>Total aprovado: <strong>${brl(r.approved_total)}</strong>${r.glosa ? ` (glosas de ${brl(r.glosa)})` : ''}</p>` });
      if (c === null) return; act('approve', { comment: c }, 'Prestação aprovada').catch(fail);
    };
    $('#dv').onclick = async () => { const c = await prompt({ title: 'Devolver para ajuste', label: 'O que precisa ser ajustado?' }); if (c) act('return', { comment: c }, 'Prestação devolvida').catch(fail); };
    $('#rj').onclick = async () => { const c = await prompt({ title: 'Rejeitar prestação', label: 'Motivo da rejeição', okLabel: 'Rejeitar', kind: 'danger solid' }); if (c) act('reject', { comment: c }, 'Prestação rejeitada').catch(fail); };
  }
  if (r.can_finalize) {
    $('#fz').onclick = async () => {
      const c = await prompt({ title: 'Registrar pagamento / liquidação', label: 'Observação (ex.: reembolso via PIX em dd/mm, devolução recebida)', required: false, okLabel: 'Finalizar',
        extra: `<div class="alert info" style="margin-bottom:.75rem">${esc(r.balance_label)}: <strong>${brl(Math.abs(r.balance))}</strong>${r.advance_id ? `<br>O adiantamento #${r.advance_id} será marcado como liquidado.` : ''}</div>` });
      if (c === null) return; act('finalize', { note: c }, 'Prestação finalizada').catch(fail);
    };
  }
};

// ---------- Adiantamentos ----------
PAGES.adiantamentos = async (page) => {
  page.innerHTML = head('Adiantamentos', 'Verbas antecipadas aos colaboradores e sua liquidação nas prestações de contas', isAdmin() ? '<button class="btn primary" id="na">+ Novo adiantamento</button>' : '');
  const [rows, bal] = await Promise.all([api('/advances'), api('/analytics/advances')]);
  const box = document.createElement('div');
  box.className = 'stack';
  box.innerHTML = `<div class="card"><h2>Saldo por colaborador</h2><div class="table-wrap"><table class="t"><thead><tr><th>Colaborador</th><th class="num">Qtd.</th><th class="num">Pago (total)</th><th class="num">Em aberto (a prestar contas)</th><th class="num">Liquidado</th></tr></thead><tbody>
    ${bal.map((b) => `<tr><td>${esc(b.user)}</td><td class="num">${b.count}</td><td class="num">${brl(b.paid)}</td><td class="num">${brl(b.open)}</td><td class="num">${brl(b.settled)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sem adiantamentos</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>Lançamentos</h2><div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Colaborador</th><th>Finalidade</th><th class="num">Valor</th><th>Previsto</th><th>Situação</th><th>Prestação</th><th>Criado</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td>${a.id}</td><td>${esc(a.user_name)}</td><td>${esc(a.purpose)}${a.notes ? `<div class="muted small">${esc(a.notes)}</div>` : ''}</td><td class="num">${brl(a.amount)}</td><td>${dt(a.expected_date)}</td><td>${advBadge(a.status)}</td>
      <td>${a.report_id ? `<a href="#/prestacao/${a.report_id}">#${a.report_id}</a> ${reportBadge(a.report_status)}` : '—'}</td><td>${dt(a.created_at)}</td>
      <td>${isAdmin() ? `<div class="row">${a.status === 'solicitado' ? `<button class="btn sm good" data-a="approve" data-id="${a.id}">Aprovar</button>` : ''}${['solicitado', 'aprovado'].includes(a.status) ? `<button class="btn sm" data-a="pay" data-id="${a.id}">Marcar pago</button><button class="btn sm danger" data-a="reject" data-id="${a.id}">Rejeitar</button>` : ''}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhum adiantamento</td></tr>'}
    </tbody></table></div></div>`;
  page.append(box);
  $$('[data-a]', box).forEach((b) => (b.onclick = async () => {
    const notes = b.dataset.a === 'reject' ? await prompt({ title: 'Rejeitar adiantamento', label: 'Motivo' }) : '';
    if (notes === null) return;
    await api(`/advances/${b.dataset.id}/${b.dataset.a}`, { method: 'POST', body: { notes: notes || null } }).then(() => { toast('Adiantamento atualizado', 'good'); PAGES.adiantamentos(page); }, fail);
  }));
  const na = $('#na');
  if (na) na.onclick = () => modal({
    title: 'Novo adiantamento', body: `<div class="form-grid"><label class="f span2">Colaborador<select id="au">${users.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f">Valor (R$)<input type="number" step="0.01" id="av"></label><label class="f">Data prevista<input type="date" id="ad"></label>
      <label class="f full">Finalidade<input id="ap" placeholder="Ex.: Viagem a cliente em Curitiba"></label><label class="f full">Observações<textarea id="ao"></textarea></label></div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async ({ el }) => {
      await api('/advances', { method: 'POST', body: { user_id: $('#au', el).value, amount: $('#av', el).value, expected_date: $('#ad', el).value, purpose: $('#ap', el).value, notes: $('#ao', el).value } });
      toast('Adiantamento criado (aprovado)', 'good'); PAGES.adiantamentos(page);
    } }],
  });
};

// ---------- Relatórios gerenciais ----------
PAGES.relatorios = async (page) => {
  page.innerHTML = head('Relatórios gerenciais', 'Consolidação e análise das despesas no período e filtros selecionados',
    '<button class="btn" id="ex-xlsx">Exportar Excel (analítico)</button><button class="btn" onclick="print()">Imprimir</button>');
  $('#ex-xlsx').onclick = () => download(`/expenses/export${qs({ ...filters, format: 'xlsx' })}`, `despesas-${today()}.xlsx`).catch(fail);
  page.append(filterBar(() => PAGES.relatorios(page)));
  const [s, m, sla, adv] = await Promise.all([
    api(`/analytics/summary${qs(filters)}`), api(`/analytics/matrix${qs(filters)}`),
    api(`/analytics/approvals${qs({ date_from: filters.date_from, date_to: filters.date_to })}`), api('/analytics/advances'),
  ]);
  const k = s.kpis;
  const tbl = (rows, labelH) => {
    const tot = rows.reduce((a, r) => a + r.total, 0);
    return `<div class="table-wrap"><table class="t"><thead><tr><th>${labelH}</th><th class="num">Qtd.</th><th class="num">Total</th><th class="num">%</th><th class="num">Aprovado</th><th class="num">Glosado</th><th class="num">Médio</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td><td class="num">${brl(r.total)}</td><td class="num">${tot ? ((r.total / tot) * 100).toFixed(1).replace(".", ",") : 0}%</td><td class="num">${brl(r.approved)}</td><td class="num">${brl(r.glosa)}</td><td class="num">${brl(r.total / r.count)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sem dados</td></tr>'}
    </tbody><tfoot><tr><td>Total</td><td class="num">${rows.reduce((a, r) => a + r.count, 0)}</td><td class="num">${brl(tot)}</td><td class="num">100%</td><td class="num">${brl(rows.reduce((a, r) => a + r.approved, 0))}</td><td class="num">${brl(rows.reduce((a, r) => a + r.glosa, 0))}</td><td></td></tr></tfoot></table></div>`;
  };
  const R = {
    categoria: ['Por categoria', tbl(s.by_category, 'Categoria')],
    usuario: ['Por usuário', tbl(s.by_user, 'Usuário')],
    mes: ['Por mês', `<div class="chart-box"><canvas id="rch"></canvas></div>${tbl(s.by_month.map((x) => ({ ...x, label: x.label.split('-').reverse().join('/') })), 'Mês')}`],
    pagamento: ['Forma de pagamento', tbl(s.by_payment, 'Forma de pagamento')],
    adiantamento: ['Com/sem adiantamento', tbl(s.by_advance, 'Adiantamento') + `<h3 style="margin-top:1rem">Saldo de adiantamentos por colaborador</h3><div class="table-wrap"><table class="t"><thead><tr><th>Colaborador</th><th class="num">Pago</th><th class="num">Em aberto</th><th class="num">Liquidado</th></tr></thead><tbody>${adv.map((b) => `<tr><td>${esc(b.user)}</td><td class="num">${brl(b.paid)}</td><td class="num">${brl(b.open)}</td><td class="num">${brl(b.settled)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Sem dados</td></tr>'}</tbody></table></div>`],
    centro: ['Centro de custo', tbl(s.by_cost_center, 'Centro de custo')],
    documento: ['Tipo de documento', tbl(s.by_doc_type, 'Documento')],
    situacao: ['Situação', tbl(s.by_status, 'Situação')],
    fornecedores: ['Principais fornecedores', tbl(s.top_suppliers, 'Fornecedor')],
    matriz: ['Matriz usuário × categoria', `<div class="table-wrap"><table class="t"><thead><tr><th>Usuário</th>${m.categories.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
      ${m.rows.map((r) => `<tr><td>${esc(r.user)}</td>${m.categories.map((c) => `<td class="num">${r.values[c] ? brl(r.values[c]) : '<span class="muted">—</span>'}</td>`).join('')}<td class="num"><strong>${brl(r.total)}</strong></td></tr>`).join('') || '<tr><td class="empty">Sem dados</td></tr>'}</tbody></table></div>`],
    aprovacao: ['Prazos de aprovação', `<div class="kpis"><div class="kpi"><div class="label">Prestações enviadas</div><div class="value">${sla.submitted}</div></div>
      <div class="kpi"><div class="label">Envio → aprovação supervisor</div><div class="value">${sla.supervisor_days ?? '—'} dias</div></div>
      <div class="kpi"><div class="label">Envio → aprovação final</div><div class="value">${sla.approval_days ?? '—'} dias</div></div>
      <div class="kpi"><div class="label">Aprovação → pagamento</div><div class="value">${sla.payment_days ?? '—'} dias</div></div></div>
      <div style="margin-top:1rem">${hbars(sla.by_status.map((x) => ({ label: x.label, total: x.count, count: x.count })), { fmt: (v) => String(v) })}</div>`],
  };
  const box = document.createElement('div');
  box.innerHTML = `<div class="kpis" style="margin-bottom:1rem">
      <div class="kpi"><div class="label">Total</div><div class="value">${brl(k.total)}</div><div class="sub">${k.count} lançamentos</div></div>
      <div class="kpi"><div class="label">Aprovado</div><div class="value">${brl(k.approved)}</div></div>
      <div class="kpi"><div class="label">Em análise</div><div class="value">${brl(k.in_analysis)}</div></div>
      <div class="kpi"><div class="label">Glosado</div><div class="value">${brl(k.glosa)}</div></div>
      <div class="kpi"><div class="label">Com adiantamento</div><div class="value">${brl(k.with_advance)}</div></div>
      <div class="kpi"><div class="label">Ticket médio</div><div class="value">${brl(k.average)}</div></div></div>
    <div class="tabs">${Object.entries(R).map(([key, [lbl]], i) => `<button data-r="${key}" class="${i === 0 ? 'on' : ''}">${lbl}</button>`).join('')}</div><div class="card" data-out></div>`;
  page.append(box);
  const out = $('[data-out]', box);
  const show = (key) => {
    $$('[data-r]', box).forEach((b) => b.classList.toggle('on', b.dataset.r === key));
    out.innerHTML = `<h2>${R[key][0]}</h2>${R[key][1]}`;
    if (key === 'mes') lineChart($('#rch', out), s.by_month);
  };
  $$('[data-r]', box).forEach((b) => (b.onclick = () => show(b.dataset.r)));
  show('categoria');
};

// ---------- Auditoria ----------
PAGES.auditoria = async (page) => {
  page.innerHTML = head('Auditoria de edições', 'Todas as edições, glosas e exclusões de lançamentos, com os valores antes e depois');
  const fl = document.createElement('div');
  fl.className = 'card';
  fl.innerHTML = `<form class="filters"><label class="f">Editor<select name="editor_id"><option value="">Todos</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
    <label class="f">Ação<select name="action">${optionList({ edicao: 'Edição', glosa: 'Glosa', restauracao: 'Glosa removida', exclusao: 'Exclusão' }, '', 'Todas')}</select></label>
    <label class="f">De<input type="date" name="date_from"></label><label class="f">Até<input type="date" name="date_to"></label>
    <label class="f">Despesa nº<input name="expense_id" inputmode="numeric"></label><div class="actions"><button class="btn primary">Filtrar</button></div></form>`;
  const list = document.createElement('div');
  list.style.marginTop = '1rem';
  page.append(fl, list);
  const load = async () => {
    const f = Object.fromEntries([...new FormData($('form', fl))].filter(([, v]) => v));
    const rows = await api(`/audit${qs(f)}`);
    const L = { edicao: 'Edição', exclusao: 'Exclusão', glosa: 'Glosa', restauracao: 'Glosa removida' };
    list.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Despesa</th><th>Titular</th><th>Editor</th><th>Ação</th><th>Alterações (antes → depois)</th><th>Justificativa</th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${dtt(x.created_at)}</td><td>${x.amount_cents != null ? `<a href="#" data-e="${x.expense_id}">#${x.expense_id}</a>` : `#${x.expense_id} <span class="muted small">(excluída)</span>`}</td><td>${esc(x.owner_name || '—')}</td>
      <td>${esc(x.editor_name)}<div class="muted small">${esc(session.meta.roles[x.editor_role])}</div></td><td><span class="badge ${x.action === 'exclusao' || x.action === 'glosa' ? 'bad' : 'info'}">${L[x.action] || x.action}</span></td>
      <td><table class="diff">${x.changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="b">${esc(c.before)}</td><td class="a">${esc(c.after)}</td></tr>`).join('')}</table></td><td>${esc(x.reason || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum registro</td></tr>'}
    </tbody></table></div>`;
    $$('[data-e]', list).forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); expenseDetail(Number(a.dataset.e), load); }));
  };
  $('form', fl).onsubmit = (ev) => { ev.preventDefault(); load(); };
  await load();
};

// ---------- Notificações ----------
PAGES.notificacoes = async (page) => {
  const n = await api('/notifications');
  page.innerHTML = head('Notificações', `${n.unread} não lida(s)`, '<button class="btn" id="ra">Marcar todas como lidas</button>');
  const box = document.createElement('div');
  box.className = 'stack';
  box.innerHTML = n.items.map((x) => `<div class="card" style="${x.read_at ? 'opacity:.75' : 'border-left:3px solid var(--primary)'}">
    <div class="row between"><strong>${esc(x.title)}</strong><span class="muted small">${dtt(x.created_at)}</span></div>
    ${x.data?.changes ? `<table class="diff" style="margin-top:.4rem"><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>${x.data.changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="b">${esc(c.before)}</td><td class="a">${esc(c.after)}</td></tr>`).join('')}</tbody></table>${x.data.reason ? `<div class="small" style="margin-top:.3rem"><b>Justificativa:</b> ${esc(x.data.reason)}</div>` : ''}`
      : x.body ? `<div style="white-space:pre-line;margin-top:.3rem">${esc(x.body)}</div>` : ''}
    <div class="row" style="margin-top:.5rem">${x.link ? `<button class="btn sm" data-go="${esc(x.link)}" data-id="${x.id}">Abrir</button>` : ''}${x.read_at ? '' : `<button class="btn sm ghost" data-rd="${x.id}">Marcar como lida</button>`}</div></div>`).join('') || '<div class="empty">Sem notificações</div>';
  page.append(box);
  $('#ra').onclick = async () => { await api('/notifications/read-all', { method: 'POST' }); refreshCounters(); PAGES.notificacoes(page); };
  $$('[data-rd]', box).forEach((b) => (b.onclick = async () => { await api(`/notifications/${b.dataset.rd}/read`, { method: 'POST' }); refreshCounters(); PAGES.notificacoes(page); }));
  $$('[data-go]', box).forEach((b) => (b.onclick = async () => {
    await api(`/notifications/${b.dataset.id}/read`, { method: 'POST' });
    refreshCounters();
    const m = b.dataset.go.match(/^#\/despesa\/(\d+)/);
    if (m) expenseDetail(Number(m[1])); else location.hash = b.dataset.go;
  }));
};

// ---------- Usuários ----------
PAGES.usuarios = async (page) => {
  users = await api('/users');
  page.innerHTML = head('Usuários e equipes', 'Cadastro de usuários, perfis e vínculo com supervisores', isAdmin() ? '<button class="btn primary" id="nu">+ Novo usuário</button>' : '');
  const box = document.createElement('div');
  box.innerHTML = `<div class="alert info" style="margin-bottom:1rem"><b>Perfis:</b> Administrador master (acesso total, gerencia gestores) · Gestor (cadastros, gestão de todos os lançamentos, aprovação final, recebe notificações de edição) · Supervisor (confere, edita campos permitidos e aprova as despesas do seu time) · Colaborador (lança despesas e prestações de contas).</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Supervisor</th><th>Centro de custo</th><th>Departamento</th><th>Situação</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(session.meta.roles[u.role])}</td><td>${esc(u.supervisor_name || '—')}</td><td>${esc(u.cost_center || '—')}</td><td>${esc(u.department || '—')}</td>
      <td>${u.active ? '<span class="badge good">Ativo</span>' : '<span class="badge">Inativo</span>'}</td><td>${canManage(u) ? `<button class="btn sm" data-u="${u.id}">Editar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  page.append(box);
  const nu = $('#nu'); if (nu) nu.onclick = () => userForm(null, () => PAGES.usuarios(page));
  $$('[data-u]', box).forEach((b) => (b.onclick = () => userForm(users.find((u) => u.id === Number(b.dataset.u)), () => PAGES.usuarios(page))));
};
const canManage = (u) => session.me.role === 'master' || (session.me.role === 'gestor' && ['supervisor', 'colaborador'].includes(u.role));
function userForm(u, done) {
  const roles = session.me.role === 'master' ? session.meta.roles : { supervisor: 'Supervisor', colaborador: 'Colaborador' };
  const sups = users.filter((x) => ['supervisor', 'gestor', 'master'].includes(x.role) && x.active && x.id !== u?.id);
  modal({
    title: u ? `Editar ${u.name}` : 'Novo usuário',
    body: `<div class="form-grid">
      <label class="f span2">Nome<input id="n" value="${esc(u?.name || '')}"></label><label class="f span2">E-mail<input id="e" type="email" value="${esc(u?.email || '')}"></label>
      <label class="f">Perfil<select id="r">${optionList(roles, u?.role || 'colaborador')}</select></label>
      <label class="f">Supervisor / aprovador<select id="s"><option value="">Nenhum (vai direto ao gestor)</option>${sups.map((x) => `<option value="${x.id}" ${u?.supervisor_id === x.id ? 'selected' : ''}>${esc(x.name)} (${esc(session.meta.roles[x.role])})</option>`).join('')}</select></label>
      <label class="f">Centro de custo<input id="cc" value="${esc(u?.cost_center || '')}"></label><label class="f">Departamento<input id="dp" value="${esc(u?.department || '')}"></label>
      <label class="f">CPF<input id="cpf" value="${esc(u?.cpf || '')}"></label>
      <label class="f">${u ? 'Nova senha (opcional)' : 'Senha inicial'}<input id="p" type="password" autocomplete="new-password"></label>
      ${u ? `<label class="f"><span>Situação</span><select id="a"><option value="1" ${u.active ? 'selected' : ''}>Ativo</option><option value="0" ${u.active ? '' : 'selected'}>Inativo</option></select></label>` : ''}
    </div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async ({ el }) => {
      const b = { name: $('#n', el).value, email: $('#e', el).value, role: $('#r', el).value, supervisor_id: $('#s', el).value || null, cost_center: $('#cc', el).value, department: $('#dp', el).value, cpf: $('#cpf', el).value };
      const p = $('#p', el).value; if (p) b.password = p;
      if (u) { b.active = $('#a', el).value === '1'; await api(`/users/${u.id}`, { method: 'PUT', body: b }); } else await api('/users', { method: 'POST', body: b });
      toast('Usuário salvo', 'good'); done();
    } }],
  });
}

// ---------- Categorias ----------
PAGES.categorias = async (page) => {
  session.meta = await api('/meta');
  const cats = session.meta.categories;
  page.innerHTML = head('Categorias e limites', 'Limite por lançamento gera alerta na conferência; categorias podem exigir comprovante', '<button class="btn primary" id="nc">+ Nova categoria</button>');
  const box = document.createElement('div');
  box.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Categoria</th><th class="num">Limite por despesa</th><th>Exige comprovante</th><th>Situação</th><th></th></tr></thead><tbody>
    ${cats.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.limit_cents ? brl(c.limit_cents / 100) : '—'}</td><td>${c.requires_receipt ? 'Sim' : 'Não'}</td><td>${c.active ? '<span class="badge good">Ativa</span>' : '<span class="badge">Inativa</span>'}</td><td><button class="btn sm" data-c="${c.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`;
  page.append(box);
  const form = (c) => modal({
    title: c ? 'Editar categoria' : 'Nova categoria',
    body: `<div class="form-grid"><label class="f span2">Nome<input id="cn" value="${esc(c?.name || '')}"></label><label class="f">Limite por despesa (R$)<input id="cl" type="number" step="0.01" value="${c?.limit_cents ? c.limit_cents / 100 : ''}" placeholder="sem limite"></label>
      <label class="f">Exige comprovante<select id="cr"><option value="1">Sim</option><option value="0" ${c && !c.requires_receipt ? 'selected' : ''}>Não</option></select></label>
      ${c ? `<label class="f">Situação<select id="ca"><option value="1">Ativa</option><option value="0" ${c.active ? '' : 'selected'}>Inativa</option></select></label>` : ''}</div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async ({ el }) => {
      const b = { name: $('#cn', el).value, limit: $('#cl', el).value || null, requires_receipt: $('#cr', el).value === '1' };
      if (c) { b.active = $('#ca', el).value === '1'; await api(`/categories/${c.id}`, { method: 'PUT', body: b }); } else await api('/categories', { method: 'POST', body: b });
      toast('Categoria salva', 'good'); PAGES.categorias(page);
    } }],
  });
  $('#nc').onclick = () => form(null);
  $$('[data-c]', box).forEach((b) => (b.onclick = () => form(cats.find((c) => c.id === Number(b.dataset.c)))));
};

// ---------- Configurações ----------
PAGES.config = async (page) => {
  const s = await api('/settings');
  const editable = JSON.parse(s.supervisor_editable_fields || '[]');
  page.innerHTML = head('Configurações', 'Regras de aprovação, permissões do supervisor e leitura automática');
  const box = document.createElement('div');
  box.className = 'stack';
  box.innerHTML = `
    <div class="card"><h2>Empresa</h2><label class="f">Nome da empresa<input id="cn" value="${esc(s.company_name)}"></label></div>
    <div class="card"><h2>Rotina de aprovação</h2><div class="form-grid">
      <label class="f span2">Alçada do supervisor (R$)<input id="lim" type="number" step="0.01" value="${Number(s.supervisor_approval_limit_cents) / 100 || ''}" placeholder="0 = sempre exige gestor">
        <span class="muted small">Prestações com total aprovado até este valor são aprovadas em definitivo pelo supervisor. Acima disso, seguem para o gestor.</span></label>
      <label class="f">Prazo máximo para lançar (dias)<input id="md" type="number" value="${esc(s.max_days_to_submit)}"><span class="muted small">0 = sem limite</span></label>
    </div></div>
    <div class="card"><h2>Campos que o supervisor pode editar</h2><p class="muted">O supervisor edita somente lançamentos do seu time, antes da aprovação do gestor. Toda edição gera notificação ao gestor com antes/depois.</p>
      <div class="form-grid">${Object.entries(session.meta.fields).map(([k, v]) => `<label class="row" style="gap:.4rem"><input type="checkbox" value="${k}" data-sf ${editable.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>
    <div class="card"><h2>Notificações de edição</h2><label class="row" style="gap:.4rem"><input type="checkbox" id="nd" ${s.notify_owner_draft_edits === '1' ? 'checked' : ''}> Notificar o gestor também quando o próprio colaborador edita um lançamento ainda em rascunho</label>
      <p class="muted small">Edições feitas por supervisores, gestores e masters — e qualquer edição de lançamentos enviados — sempre geram notificação.</p></div>
    <div class="card"><h2>Leitura automática de comprovantes</h2>${s.ocr_enabled
      ? `<div class="alert good">Ativa — modelo <code>${esc(s.ocr_model)}</code>. Fotos de notas, cupons e recibos preenchem os campos automaticamente.</div>`
      : '<div class="alert warn">Inativa. Defina a variável de ambiente <code>ANTHROPIC_API_KEY</code> no servidor e reinicie para habilitar o preenchimento automático pela foto.</div>'}</div>
    <div><button class="btn primary" id="sv">Salvar configurações</button></div>`;
  page.append(box);
  $('#sv').onclick = async () => {
    await api('/settings', { method: 'PUT', body: {
      company_name: $('#cn').value, supervisor_approval_limit_cents: Math.round(Number($('#lim').value || 0) * 100), max_days_to_submit: Number($('#md').value || 0),
      supervisor_editable_fields: $$('[data-sf]').filter((x) => x.checked).map((x) => x.value), notify_owner_draft_edits: $('#nd').checked ? '1' : '0',
    } }).then(() => toast('Configurações salvas', 'good'), fail);
    session.meta = await api('/meta');
  };
};

// Atalho: links de notificação "#/despesa/:id" abrem o detalhe sobre a conferência
PAGES.despesa = async (page, id) => { await PAGES.conferencia(page); expenseDetail(Number(id)); };

start();
