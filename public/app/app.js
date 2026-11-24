import {
  $, $$, esc, brl, dt, dtt, today, monthStart, fmtDoc, api, qs, session, toast, fail, modal, prompt, confirmBox,
  reportBadge, expBadge, advBadge, expFlags, receiptViewer, editsHtml, expenseForm, openExpenseEdit, bootstrap, loginScreen, fileUrl,
} from '/shared/core.js';

const root = $('#root');
let unread = 0;

async function start() {
  if (!session.token) return loginScreen(root, { title: 'Lançamento de despesas', subtitle: 'Registre despesas e envie sua prestação de contas', onLogin: () => start() });
  try { await bootstrap(); } catch { session.clear(); return start(); }
  root.innerHTML = `<div class="app"><div class="topbar"><div class="brand"><span class="logo">R$</span><span id="ttl">Despesas</span></div>
    <a class="btn sm ghost" href="#/notificacoes" aria-label="Notificações">🔔 <span id="nb"></span></a></div><div id="page"></div></div>
    <nav class="bottom">
      <a href="#/inicio" data-n="inicio"><span class="ic">⌂</span>Início</a>
      <a href="#/despesas" data-n="despesas"><span class="ic">≡</span>Despesas</a>
      <a href="#/nova" data-n="nova" class="fab"><span class="ic">+</span>Lançar</a>
      <a href="#/prestacoes" data-n="prestacoes"><span class="ic">▤</span>Prestações</a>
      <a href="#/perfil" data-n="perfil"><span class="ic">☺</span>Perfil</a>
    </nav>`;
  window.addEventListener('hashchange', route);
  route();
  refreshUnread();
  setInterval(refreshUnread, 60000);
}
async function refreshUnread() {
  try { unread = (await api('/notifications?unread=1')).unread; $('#nb').innerHTML = unread ? `<span class="badge bad">${unread}</span>` : ''; } catch { /* ignora */ }
}

const P = {};
async function route() {
  const [name, arg] = location.hash.slice(2).split('?')[0].split('/');
  const key = P[name] ? name : 'inicio';
  $$('.bottom a').forEach((a) => a.classList.toggle('on', a.dataset.n === key || (key === 'despesa' && a.dataset.n === 'despesas') || (key === 'prestacao' && a.dataset.n === 'prestacoes')));
  const page = $('#page');
  page.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try { await P[key](page, arg); } catch (e) { page.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
const title = (t) => { $('#ttl').textContent = t; };

function expenseItem(e) {
  return `<div class="item" data-e="${e.id}"><div class="thumb">${e.first_attachment_id ? `<img src="${fileUrl(e.first_attachment_id)}" alt="" loading="lazy" onerror="this.replaceWith('📄')">` : '—'}</div>
    <div class="main"><div class="t">${esc(e.supplier_name || e.category_name || 'Despesa')}</div><div class="muted small">${dt(e.expense_date)} · ${esc(e.category_name || '')}</div>
    <div class="row" style="gap:.3rem;margin-top:.2rem">${expBadge(e.status)}${e.report_id ? `<span class="badge">prestação #${e.report_id}</span>` : ''}${!e.attachment_count ? '<span class="badge warn">sem comprovante</span>' : ''}${e.edit_count && e.user_id === session.me.id ? '<span class="badge info">editada</span>' : ''}</div></div>
    <div class="amt">${brl(e.amount)}</div></div>`;
}
const bindItems = (el) => $$('[data-e]', el).forEach((x) => (x.onclick = () => (location.hash = `#/despesa/${x.dataset.e}`)));
function reportItem(r) {
  return `<div class="item" data-r="${r.id}"><div class="main"><div class="t">#${r.id} · ${esc(r.title)}</div><div class="muted small">${dt(r.period_start)} – ${dt(r.period_end)} · ${r.expense_count} despesa(s)</div>
    <div style="margin-top:.2rem">${reportBadge(r.status)}</div></div><div class="amt">${brl(r.total)}${r.advance_id ? `<div class="muted small">${esc(r.balance_label)}: ${brl(Math.abs(r.balance))}</div>` : ''}</div></div>`;
}
const bindReports = (el) => $$('[data-r]', el).forEach((x) => (x.onclick = () => (location.hash = `#/prestacao/${x.dataset.r}`)));

// ---------- Início ----------
P.inicio = async (page) => {
  title('Início');
  const [loose, reports, advances] = await Promise.all([
    api(`/expenses${qs({ user_id: session.me.id, no_report: 1 })}`),
    api('/reports?mine=1'),
    api('/advances?mine=1'),
  ]);
  const open = reports.filter((r) => !['finalizada', 'rejeitada'].includes(r.status));
  const advOpen = advances.filter((a) => ['solicitado', 'aprovado', 'pago'].includes(a.status));
  const returned = reports.filter((r) => r.status === 'devolvida');
  page.innerHTML = `<div class="stack">
    <div><h1>Olá, ${esc(session.me.name.split(' ')[0])}</h1><div class="muted">${esc(session.meta.roles[session.me.role])}${session.me.supervisor ? ` · Supervisor: ${esc(session.me.supervisor.name)}` : ''}</div></div>
    <a class="btn primary big-cta" href="#/nova"><span style="font-size:28px">📷</span><span style="text-align:left">Lançar despesa<div class="small" style="font-weight:400;opacity:.9">Fotografe a nota${session.meta.ocr_enabled ? ' e os dados são preenchidos automaticamente' : ''}</div></span></a>
    ${returned.length ? `<div class="alert bad"><b>${returned.length} prestação(ões) devolvida(s) para ajuste.</b> ${returned.map((r) => `<a href="#/prestacao/${r.id}">#${r.id}</a>`).join(', ')}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="label">Sem prestação</div><div class="value">${brl(loose.total)}</div><div class="sub">${loose.count} despesa(s)</div></div>
      <div class="kpi"><div class="label">Prestações em andamento</div><div class="value">${open.length}</div><div class="sub">${brl(open.reduce((s, r) => s + r.total, 0))}</div></div>
      <div class="kpi"><div class="label">Adiantamentos em aberto</div><div class="value">${brl(advOpen.filter((a) => a.status === 'pago').reduce((s, a) => s + a.amount, 0))}</div><div class="sub">${advOpen.length} registro(s)</div></div>
    </div>
    ${loose.count ? `<div class="card"><div class="row between"><h2>Despesas ainda não prestadas</h2><button class="btn sm primary" id="mk">Criar prestação</button></div><div data-l></div></div>` : ''}
    ${open.length ? `<div class="card"><h2>Minhas prestações em andamento</h2><div data-rp></div></div>` : ''}
    <div class="row"><a class="btn" href="#/adiantamentos">Adiantamentos</a>${session.me.role !== 'colaborador' ? '<a class="btn" href="/admin/">Plataforma de administração</a>' : ''}</div>
  </div>`;
  const l = $('[data-l]', page); if (l) { l.innerHTML = loose.items.slice(0, 5).map(expenseItem).join('') + (loose.count > 5 ? `<a href="#/despesas" class="small">Ver todas (${loose.count})</a>` : ''); bindItems(l); }
  const rp = $('[data-rp]', page); if (rp) { rp.innerHTML = open.map(reportItem).join(''); bindReports(rp); }
  const mk = $('#mk'); if (mk) mk.onclick = () => newReport(loose.items);
};

// ---------- Nova despesa ----------
P.nova = async (page) => {
  title('Lançar despesa');
  const [reports, advances] = await Promise.all([api('/reports?mine=1&status=rascunho,devolvida'), api('/advances?mine=1&status=aprovado,pago')]);
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('prestacao');
  const form = expenseForm({ reports, advances, reportId: preset });
  page.innerHTML = '';
  page.append(form);
  const bar = document.createElement('div');
  bar.className = 'sticky-actions';
  bar.innerHTML = '<button class="btn" data-more>Salvar e lançar outra</button><button class="btn primary" data-save>Salvar</button>';
  page.append(bar);
  const save = async (again) => {
    const d = form.validate();
    if (!d) return;
    $$('button', bar).forEach((b) => (b.disabled = true));
    try {
      const e = await api('/expenses', { method: 'POST', body: d });
      toast('Despesa registrada', 'good');
      if (again) P.nova(page); else location.hash = d.report_id ? `#/prestacao/${d.report_id}` : `#/despesa/${e.id}`;
    } catch (err) { fail(err); $$('button', bar).forEach((b) => (b.disabled = false)); }
  };
  $('[data-save]', bar).onclick = () => save(false);
  $('[data-more]', bar).onclick = () => save(true);
};

// ---------- Lista de despesas ----------
let expFilter = 'todas';
P.despesas = async (page) => {
  title('Minhas despesas');
  const F = { todas: 'Todas', soltas: 'Sem prestação', em_analise: 'Em análise', aprovada: 'Aprovadas', glosada: 'Glosadas' };
  page.innerHTML = `<div class="stack"><div class="seg">${Object.entries(F).map(([k, v]) => `<button data-f="${k}" class="${expFilter === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <div class="row"><label class="f grow">De<input type="date" id="df" value="${monthStart(-2)}"></label><label class="f grow">Até<input type="date" id="dtt" value="${today()}"></label></div>
    <div id="sum" class="muted"></div><div id="lst"></div></div>`;
  const load = async () => {
    const q = { user_id: session.me.id, date_from: $('#df').value, date_to: $('#dtt').value };
    if (expFilter === 'soltas') q.no_report = 1; else if (expFilter !== 'todas') q.status = expFilter;
    const r = await api(`/expenses${qs(q)}`);
    $('#sum').textContent = `${r.count} despesa(s) · ${brl(r.total)}`;
    $('#lst').innerHTML = r.items.map(expenseItem).join('') || '<div class="empty">Nenhuma despesa no período</div>';
    bindItems($('#lst'));
  };
  $$('[data-f]', page).forEach((b) => (b.onclick = () => { expFilter = b.dataset.f; $$('[data-f]', page).forEach((x) => x.classList.toggle('on', x === b)); load(); }));
  $('#df').onchange = load; $('#dtt').onchange = load;
  await load();
};

// ---------- Detalhe da despesa ----------
P.despesa = async (page, id) => {
  title(`Despesa #${id}`);
  const e = await api(`/expenses/${id}`);
  page.innerHTML = `<div class="stack"><div data-v></div>
    <div class="card"><div class="row between"><h2 style="margin:0">${brl(e.amount)}</h2><div class="row">${expBadge(e.status)}</div></div>
    ${e.status === 'glosada' ? `<div class="alert bad" style="margin-top:.6rem"><b>Glosada:</b> ${esc(e.glosa_reason || '')}</div>` : ''}
    <dl class="kv" style="margin-top:.75rem">
      <dt>Data</dt><dd>${dt(e.expense_date)}</dd><dt>Categoria</dt><dd>${esc(e.category_name || '—')}</dd>
      <dt>Pagamento</dt><dd>${esc(session.meta.payment_methods[e.payment_method])}</dd>
      <dt>Documento</dt><dd>${esc(session.meta.doc_types[e.doc_type])} ${esc(e.doc_number || '')}</dd>
      <dt>Fornecedor</dt><dd>${esc(e.supplier_name || '—')} <span class="muted">${esc(fmtDoc(e.supplier_doc || ''))}</span></dd>
      <dt>Cidade</dt><dd>${esc(e.city || '—')}</dd><dt>Centro de custo</dt><dd>${esc(e.cost_center || '—')}</dd>
      <dt>Descrição</dt><dd>${esc(e.description || '—')}</dd>
      <dt>Adiantamento</dt><dd>${e.linked_advance_id ? `#${e.linked_advance_id}` : 'Não'}</dd>
      <dt>Prestação</dt><dd>${e.report_id ? `<a href="#/prestacao/${e.report_id}">#${e.report_id} ${esc(e.report_title)}</a> ${reportBadge(e.report_status)}` : 'Não incluída'}</dd>
    </dl>
    <div class="row" style="margin-top:.75rem">${e.can_edit ? '<button class="btn primary" id="ed">Editar</button><label class="btn"><input type="file" accept="image/*,application/pdf" id="add" hidden>+ Comprovante</label>' : `<span class="muted small">${esc(e.edit_block_reason || '')}</span>`}
      ${e.can_edit && (!e.report_id || ['rascunho', 'devolvida'].includes(e.report_status)) ? '<button class="btn danger" id="del">Excluir</button>' : ''}</div></div>
    ${e.edits.length ? `<div class="card"><h2>Histórico de edições</h2>${editsHtml(e.edits)}</div>` : ''}</div>`;
  $('[data-v]', page).append(receiptViewer(e.attachments));
  const reload = () => P.despesa(page, id);
  const ed = $('#ed'); if (ed) ed.onclick = async () => openExpenseEdit(e.id, { onSaved: reload, advances: await api('/advances?mine=1&status=aprovado,pago') });
  const add = $('#add'); if (add) add.onchange = async () => {
    const f = add.files[0]; if (!f) return;
    try {
      const { uploadReceipt } = await import('/shared/core.js');
      const r = await uploadReceipt(f);
      await api(`/expenses/${e.id}`, { method: 'PUT', body: { attachment_ids: [r.attachment.id], reason: 'Inclusão de comprovante' } });
      toast('Comprovante anexado', 'good'); reload();
    } catch (err) { fail(err); }
  };
  const del = $('#del'); if (del) del.onclick = async () => { if (await confirmBox('Excluir despesa', 'Deseja excluir esta despesa?', 'Excluir', 'danger solid')) { await api(`/expenses/${e.id}`, { method: 'DELETE' }).then(() => { toast('Despesa excluída', 'good'); location.hash = '#/despesas'; }, fail); } };
};

// ---------- Prestações ----------
P.prestacoes = async (page) => {
  title('Prestações de contas');
  const rows = await api('/reports?mine=1');
  page.innerHTML = `<div class="stack"><button class="btn primary" id="np">+ Nova prestação de contas</button><div id="lst"></div></div>`;
  $('#lst').innerHTML = rows.map(reportItem).join('') || '<div class="empty">Você ainda não tem prestações de contas</div>';
  bindReports($('#lst'));
  $('#np').onclick = async () => newReport((await api(`/expenses${qs({ user_id: session.me.id, no_report: 1 })}`)).items);
};

async function newReport(looseItems) {
  const advances = await api('/advances?mine=1&available=1');
  const first = looseItems.map((e) => e.expense_date).sort()[0];
  modal({
    title: 'Nova prestação de contas',
    body: `<div class="stack">
      <label class="f">Título<input id="t" placeholder="Ex.: Viagem São Paulo — cliente X" value="Prestação de contas ${new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}"></label>
      <div class="row"><label class="f grow">Período de<input type="date" id="ps" value="${first || monthStart()}"></label><label class="f grow">até<input type="date" id="pe" value="${today()}"></label></div>
      <label class="f">Adiantamento recebido<select id="ad"><option value="">Não houve adiantamento</option>${advances.map((a) => `<option value="${a.id}">#${a.id} — ${brl(a.amount)} — ${esc(a.purpose)} (${esc(session.meta.advance_status[a.status])})</option>`).join('')}</select></label>
      ${looseItems.length ? `<div><div class="row between"><strong>Incluir despesas</strong><label class="small row" style="gap:.3rem"><input type="checkbox" id="all" checked> todas</label></div>
        <div style="max-height:40vh;overflow:auto;margin-top:.4rem">${looseItems.map((e) => `<label class="row" style="gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border)"><input type="checkbox" data-x="${e.id}" checked><span class="grow">${dt(e.expense_date)} · ${esc(e.supplier_name || e.category_name)}</span><strong>${brl(e.amount)}</strong></label>`).join('')}</div></div>` : '<p class="muted">Você poderá incluir despesas depois.</p>'}
    </div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Criar', kind: 'primary', onClick: async ({ el }) => {
      const r = await api('/reports', { method: 'POST', body: {
        title: $('#t', el).value, period_start: $('#ps', el).value, period_end: $('#pe', el).value, advance_id: $('#ad', el).value || null,
        expense_ids: $$('[data-x]', el).filter((c) => c.checked).map((c) => Number(c.dataset.x)),
      } });
      toast('Prestação criada', 'good');
      location.hash = `#/prestacao/${r.id}`;
    } }],
  });
  setTimeout(() => { const all = $('#all'); if (all) all.onchange = () => $$('[data-x]').forEach((c) => (c.checked = all.checked)); });
}

P.prestacao = async (page, id) => {
  title(`Prestação #${id}`);
  const r = await api(`/reports/${id}`);
  page.innerHTML = `<div class="stack">
    <div><h1>${esc(r.title)}</h1><div class="row" style="gap:.4rem">${reportBadge(r.status)}<span class="muted small">${dt(r.period_start)} – ${dt(r.period_end)}</span></div></div>
    ${r.last_comment && ['devolvida', 'rejeitada'].includes(r.status) ? `<div class="alert bad"><b>${r.status === 'devolvida' ? 'Ajustes solicitados' : 'Motivo da rejeição'}:</b> ${esc(r.last_comment)}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="label">Total apresentado</div><div class="value">${brl(r.total)}</div><div class="sub">${r.expense_count} despesa(s)</div></div>
      <div class="kpi"><div class="label">Glosas</div><div class="value">${brl(r.glosa)}</div></div>
      <div class="kpi"><div class="label">Adiantamento</div><div class="value">${brl(r.advance_amount)}</div><div class="sub">${r.advance_id ? `#${r.advance_id} ${advBadge(r.advance_status)}` : 'sem adiantamento'}</div></div>
      <div class="kpi"><div class="label">${esc(r.balance_label)}</div><div class="value">${brl(Math.abs(r.balance))}</div></div>
    </div>
    <div class="card"><div class="row between"><h2 style="margin:0">Despesas</h2>${r.can_edit ? `<div class="row"><a class="btn sm" href="#/nova?prestacao=${r.id}">+ Nova</a><button class="btn sm" id="inc">Incluir existentes</button></div>` : ''}</div>
      <div id="lst" style="margin-top:.6rem"></div></div>
    <div class="card"><h2>Andamento</h2><ul class="timeline">${r.history.map((h) => `<li><strong>${esc(h.action.replace(/_/g, ' '))}</strong> — ${esc(h.user_name)}<div class="muted small">${dtt(h.created_at)} ${h.to_status ? '→ ' + esc(session.meta.report_status[h.to_status]) : ''}</div>${h.comment ? `<div>${esc(h.comment)}</div>` : ''}</li>`).join('')}</ul></div>
    <div class="row">${r.can_submit ? `<button class="btn primary" id="sub">${r.status === 'devolvida' ? 'Reenviar para aprovação' : 'Enviar para aprovação'}</button>` : ''}
      <button class="btn" id="pr">Imprimir / PDF</button>${r.status === 'rascunho' ? '<button class="btn danger" id="dl">Excluir rascunho</button>' : ''}</div>
  </div>`;
  const lst = $('#lst');
  lst.innerHTML = r.expenses.map((e) => `<div style="position:relative">${expenseItem(e)}${r.can_edit ? `<button class="btn sm ghost" data-rm="${e.id}" style="position:absolute;right:4px;top:4px" aria-label="Remover da prestação" title="Remover da prestação">✕</button>` : ''}</div>`).join('') || '<div class="empty">Nenhuma despesa incluída</div>';
  bindItems(lst);
  const reload = () => P.prestacao(page, id);
  $$('[data-rm]', lst).forEach((b) => (b.onclick = async (ev) => { ev.stopPropagation(); await api(`/reports/${r.id}/expenses/${b.dataset.rm}`, { method: 'DELETE' }).then(reload, fail); }));
  $('#pr').onclick = () => window.open(`/api/reports/${r.id}/print?token=${encodeURIComponent(session.token)}`, '_blank');
  const dl = $('#dl'); if (dl) dl.onclick = async () => { if (await confirmBox('Excluir rascunho', 'As despesas voltarão para a lista de não prestadas.', 'Excluir', 'danger solid')) api(`/reports/${r.id}`, { method: 'DELETE' }).then(() => (location.hash = '#/prestacoes'), fail); };
  const inc = $('#inc'); if (inc) inc.onclick = async () => {
    const loose = (await api(`/expenses${qs({ user_id: session.me.id, no_report: 1 })}`)).items;
    if (!loose.length) return toast('Não há despesas fora de prestação');
    modal({ title: 'Incluir despesas', body: loose.map((e) => `<label class="row" style="gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border)"><input type="checkbox" data-x="${e.id}"><span class="grow">${dt(e.expense_date)} · ${esc(e.supplier_name || e.category_name)}</span><strong>${brl(e.amount)}</strong></label>`).join(''),
      actions: [{ label: 'Cancelar' }, { label: 'Incluir', kind: 'primary', onClick: async ({ el }) => { await api(`/reports/${r.id}/expenses`, { method: 'POST', body: { expense_ids: $$('[data-x]', el).filter((c) => c.checked).map((c) => Number(c.dataset.x)) } }); reload(); } }] });
  };
  const sub = $('#sub'); if (sub) sub.onclick = async () => {
    const comment = await prompt({ title: 'Enviar para aprovação', label: 'Comentário para o aprovador (opcional)', required: false, okLabel: 'Enviar',
      extra: `<p>Total: <strong>${brl(r.total)}</strong>. Após o envio as despesas não poderão ser alteradas, salvo se a prestação for devolvida.</p>` });
    if (comment === null) return;
    try {
      await api(`/reports/${r.id}/submit`, { method: 'POST', body: { comment } });
    } catch (e) {
      if (e.body?.code !== 'missing_receipts') return fail(e);
      if (!(await confirmBox('Comprovantes faltando', e.message, 'Enviar mesmo assim'))) return;
      await api(`/reports/${r.id}/submit`, { method: 'POST', body: { comment, confirm_missing_receipts: true } }).catch(fail);
    }
    toast('Prestação enviada para aprovação', 'good'); reload();
  };
};

// ---------- Adiantamentos ----------
P.adiantamentos = async (page) => {
  title('Adiantamentos');
  const rows = await api('/advances?mine=1');
  page.innerHTML = `<div class="stack"><button class="btn primary" id="na">Solicitar adiantamento</button>
    ${rows.map((a) => `<div class="item"><div class="main"><div class="t">#${a.id} · ${esc(a.purpose)}</div><div class="muted small">Solicitado em ${dt(a.created_at)}${a.expected_date ? ` · previsto ${dt(a.expected_date)}` : ''}</div>
      <div style="margin-top:.2rem">${advBadge(a.status)} ${a.report_id ? `<a class="badge" href="#/prestacao/${a.report_id}">prestação #${a.report_id}</a>` : ''}</div>${a.notes ? `<div class="small muted">${esc(a.notes)}</div>` : ''}</div><div class="amt">${brl(a.amount)}</div></div>`).join('') || '<div class="empty">Nenhum adiantamento</div>'}</div>`;
  $('#na').onclick = () => modal({
    title: 'Solicitar adiantamento',
    body: `<div class="stack"><label class="f">Valor (R$)<input type="number" step="0.01" inputmode="decimal" id="v"></label><label class="f">Finalidade<input id="p" placeholder="Ex.: Viagem para visita técnica"></label><label class="f">Data prevista<input type="date" id="d"></label><label class="f">Observações<textarea id="o"></textarea></label></div>`,
    actions: [{ label: 'Cancelar' }, { label: 'Solicitar', kind: 'primary', onClick: async ({ el }) => { await api('/advances', { method: 'POST', body: { amount: $('#v', el).value, purpose: $('#p', el).value, expected_date: $('#d', el).value, notes: $('#o', el).value } }); toast('Solicitação enviada ao gestor', 'good'); P.adiantamentos(page); } }],
  });
};

// ---------- Notificações ----------
P.notificacoes = async (page) => {
  title('Notificações');
  const n = await api('/notifications');
  page.innerHTML = `<div class="stack"><button class="btn sm" id="ra" style="align-self:flex-start">Marcar todas como lidas</button>${n.items.map((x) => `<div class="card" style="${x.read_at ? 'opacity:.7' : 'border-left:3px solid var(--primary)'}" data-go="${esc(x.link || '')}" data-id="${x.id}">
    <strong>${esc(x.title)}</strong><div class="muted small">${dtt(x.created_at)}</div>${x.body ? `<div style="white-space:pre-line;margin-top:.3rem" class="small">${esc(x.body)}</div>` : ''}</div>`).join('') || '<div class="empty">Sem notificações</div>'}</div>`;
  $('#ra').onclick = async () => { await api('/notifications/read-all', { method: 'POST' }); refreshUnread(); P.notificacoes(page); };
  $$('[data-go]', page).forEach((c) => (c.onclick = async () => { await api(`/notifications/${c.dataset.id}/read`, { method: 'POST' }); refreshUnread(); if (c.dataset.go) location.hash = c.dataset.go; }));
};

// ---------- Perfil ----------
P.perfil = async (page) => {
  title('Perfil');
  const me = session.me;
  page.innerHTML = `<div class="stack"><div class="card"><h2>${esc(me.name)}</h2><dl class="kv"><dt>E-mail</dt><dd>${esc(me.email)}</dd><dt>Perfil</dt><dd>${esc(session.meta.roles[me.role])}</dd>
    <dt>Supervisor</dt><dd>${esc(me.supervisor?.name || '—')}</dd><dt>Centro de custo</dt><dd>${esc(me.cost_center || '—')}</dd></dl></div>
    <div class="card"><h2>Alterar senha</h2><div class="stack"><label class="f">Senha atual<input type="password" id="pc"></label><label class="f">Nova senha<input type="password" id="pn"></label><button class="btn" id="sp">Salvar senha</button></div></div>
    <div class="row"><a class="btn" href="#/adiantamentos">Adiantamentos</a><a class="btn" href="#/notificacoes">Notificações</a>${me.role !== 'colaborador' ? '<a class="btn" href="/admin/">Plataforma de administração</a>' : ''}<button class="btn danger" id="lo">Sair</button></div></div>`;
  $('#sp').onclick = () => api('/me/password', { method: 'POST', body: { current: $('#pc').value, password: $('#pn').value } }).then(() => toast('Senha alterada', 'good'), fail);
  $('#lo').onclick = () => { session.clear(); location.hash = ''; location.reload(); };
};

start();
