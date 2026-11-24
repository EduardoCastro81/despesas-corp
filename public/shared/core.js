// Utilitários compartilhados pelas plataformas de administração e de lançamento
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const dt = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
export const dtt = (s) => (s ? `${dt(s)} ${s.slice(11, 16)}` : '—');
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const monthStart = (offset = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const fmtDoc = (d) => {
  if (!d) return '';
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};

// ---------- Sessão ----------
const TOKEN_KEY = 'dc_token';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sem storage */ } },
};
let memToken = store.get(TOKEN_KEY);
export const session = {
  get token() { return memToken; },
  set(t) { memToken = t; store.set(TOKEN_KEY, t); },
  clear() { memToken = null; store.del(TOKEN_KEY); },
  me: null,
  meta: null,
};

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body, form, raw } = {}) {
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (raw) { if (!res.ok) throw new ApiError(res.status, 'Falha no download'); return res; }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/auth/login') {
    session.clear();
    location.reload();
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Erro ${res.status}`, data);
  return data;
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const fileUrl = (id, download = false) => `/api/files/${id}?token=${encodeURIComponent(session.token)}${download ? '&download=1' : ''}`;

export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- Feedback ----------
export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3500);
}
export const fail = (e) => toast(e?.message || String(e), 'bad');

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="btn ghost sm" data-x aria-label="Fechar">✕</button></header>
    <div class="body"></div><footer></footer></div>`;
  const bodyEl = $('.body', back);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  const foot = $('footer', back);
  if (!actions.length) foot.remove();
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { const r = await a.onClick({ close, el: bodyEl }); if (r !== false) close(); } catch (e) { fail(e); } finally { b.disabled = false; }
    };
    foot.append(b);
  }
  $('[data-x]', back).onclick = close;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  $('input, select, textarea', bodyEl)?.focus();
  return { el: bodyEl, close };
}

export function prompt({ title, label, required = true, placeholder = '', okLabel = 'Confirmar', kind = 'primary', textarea = true, extra = '' }) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: `${extra}<label class="f">${esc(label)}${textarea ? `<textarea id="pr-v" placeholder="${esc(placeholder)}"></textarea>` : `<input id="pr-v" placeholder="${esc(placeholder)}">`}</label>`,
      actions: [
        { label: 'Cancelar' },
        { label: okLabel, kind, onClick: ({ el }) => {
          const v = $('#pr-v', el).value.trim();
          if (required && !v) { toast('Preenchimento obrigatório', 'bad'); return false; }
          done = true; resolve(v);
        } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

export function confirmBox(title, text, okLabel = 'Confirmar', kind = 'primary') {
  return new Promise((resolve) => {
    let done = false;
    modal({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancelar' }, { label: okLabel, kind, onClick: () => { done = true; resolve(true); } }], onClose: () => { if (!done) resolve(false); } });
  });
}

// ---------- Selos de status ----------
const REPORT_KIND = { rascunho: '', aguardando_supervisor: 'warn', aguardando_gestor: 'warn', devolvida: 'bad', aprovada: 'good', rejeitada: 'bad', finalizada: 'info' };
const EXP_KIND = { rascunho: '', em_analise: 'warn', aprovada: 'good', glosada: 'bad' };
const ADV_KIND = { solicitado: 'warn', aprovado: 'info', pago: 'good', rejeitado: 'bad', liquidado: '' };
export const reportBadge = (s) => `<span class="badge ${REPORT_KIND[s] ?? ''}">${esc(session.meta?.report_status?.[s] || s)}</span>`;
export const expBadge = (s) => `<span class="badge ${EXP_KIND[s] ?? ''}">${esc(session.meta?.expense_status?.[s] || s)}</span>`;
export const advBadge = (s) => `<span class="badge ${ADV_KIND[s] ?? ''}">${esc(session.meta?.advance_status?.[s] || s)}</span>`;
export function expFlags(e) {
  const f = [];
  if (e.over_limit) f.push(`<span class="badge warn" title="Acima do limite da categoria (${brl(e.category_limit)})">⚠ limite</span>`);
  if (e.possible_duplicate) f.push('<span class="badge bad" title="Mesma nota, valor ou data/fornecedor em outro lançamento">⧉ duplicidade?</span>');
  if (!e.attachment_count) f.push('<span class="badge" title="Sem comprovante anexado">sem comprovante</span>');
  if (e.edit_count) f.push(`<span class="badge info" title="Editada ${e.edit_count} vez(es)">✎ editada</span>`);
  if (e.has_advance) f.push('<span class="badge" title="Vinculada a adiantamento">adiant.</span>');
  return `<span class="flags">${f.join('')}</span>`;
}

export const optionList = (obj, selected, empty) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${String(selected ?? '') === String(k) ? 'selected' : ''}>${esc(v)}</option>`).join('');

export const catOptions = (selected, empty = 'Selecione...', includeInactive = false) =>
  `<option value="">${esc(empty)}</option>` + (session.meta?.categories || [])
    .filter((c) => includeInactive || c.active || String(c.id) === String(selected))
    .map((c) => `<option value="${c.id}" ${String(selected ?? '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

// ---------- Visualizador de comprovantes ----------
export function receiptViewer(attachments) {
  const el = document.createElement('div');
  el.className = 'viewer';
  if (!attachments?.length) {
    el.innerHTML = '<div class="stage"><div class="empty">Nenhum comprovante anexado</div></div>';
    return el;
  }
  let idx = 0; let zoom = 1; let rot = 0;
  const render = () => {
    const a = attachments[idx];
    const isPdf = a.mime === 'application/pdf';
    el.innerHTML = `<div class="stage">${isPdf ? `<iframe src="${fileUrl(a.id)}" title="Comprovante PDF"></iframe>` : `<img src="${fileUrl(a.id)}" alt="Comprovante ${idx + 1}" style="transform: scale(${zoom}) rotate(${rot}deg)">`}</div>
      <div class="tools">
        ${attachments.length > 1 ? `<div class="thumbs">${attachments.map((x, i) => `<button data-i="${i}" class="${i === idx ? 'on' : ''}" title="${esc(x.original_name || '')}">${x.mime === 'application/pdf' ? 'PDF' : `<img src="${fileUrl(x.id)}" alt="">`}</button>`).join('')}</div>` : ''}
        <span class="grow"></span>
        ${isPdf ? '' : '<button class="btn sm" data-z="-1" aria-label="Diminuir zoom">−</button><button class="btn sm" data-z="1" aria-label="Aumentar zoom">+</button><button class="btn sm" data-r aria-label="Girar">⟳</button>'}
        <a class="btn sm" href="${fileUrl(a.id)}" target="_blank" rel="noopener">Abrir</a>
        <a class="btn sm" href="${fileUrl(a.id, true)}">Baixar</a>
      </div>`;
    $$('[data-i]', el).forEach((b) => (b.onclick = () => { idx = Number(b.dataset.i); zoom = 1; rot = 0; render(); }));
    $$('[data-z]', el).forEach((b) => (b.onclick = () => { zoom = Math.min(4, Math.max(0.5, zoom + Number(b.dataset.z) * 0.25)); $('img', $('.stage', el)).style.transform = `scale(${zoom}) rotate(${rot}deg)`; }));
    const r = $('[data-r]', el); if (r) r.onclick = () => { rot = (rot + 90) % 360; $('img', $('.stage', el)).style.transform = `scale(${zoom}) rotate(${rot}deg)`; };
  };
  render();
  return el;
}

// ---------- Diff de edições ----------
export function editsHtml(edits) {
  if (!edits?.length) return '<p class="muted">Nenhuma edição registrada.</p>';
  const actionLbl = { edicao: 'Edição', exclusao: 'Exclusão', glosa: 'Glosa', restauracao: 'Glosa removida' };
  return edits.map((x) => `<div class="card" style="padding:.7rem">
    <div class="row between"><strong>${esc(actionLbl[x.action] || x.action)} por ${esc(x.editor_name)} <span class="muted small">(${esc(session.meta?.roles?.[x.editor_role] || x.editor_role)})</span></strong><span class="muted small">${dtt(x.created_at)}</span></div>
    <table class="diff"><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>
    ${x.changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="b">${esc(c.before)}</td><td class="a">${esc(c.after)}</td></tr>`).join('')}
    </tbody></table>${x.reason ? `<div class="small" style="margin-top:.35rem"><b>Justificativa:</b> ${esc(x.reason)}</div>` : ''}</div>`).join('');
}

// ---------- Imagem: compressão antes do envio ----------
export async function prepareImage(file, maxSide = 2000) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], (file.name || 'foto').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // navegador não decodificou (ex.: HEIC em alguns sistemas) — envia original
  }
}

export async function uploadReceipt(file, { ocr = false } = {}) {
  const f = await prepareImage(file);
  const fd = new FormData();
  fd.append('file', f, f.name || 'comprovante');
  return api(`/uploads${ocr ? '?ocr=1' : ''}`, { method: 'POST', form: fd });
}

// ---------- Formulário de despesa (lançamento/edição) ----------
// opts: { expense, editableFields: 'all' | [...], requireReason, users (para gestor lançar p/ terceiros), advances, reports, onSaved }
export function expenseForm(opts = {}) {
  const e = opts.expense || {};
  const meta = session.meta;
  const editable = (f) => opts.editableFields === undefined || opts.editableFields === 'all' || opts.editableFields.includes(f);
  const dis = (f) => (editable(f) ? '' : 'disabled title="Seu perfil não pode alterar este campo"');
  const el = document.createElement('form');
  el.className = 'stack';
  el.noValidate = true;
  const isNew = !e.id;
  el.innerHTML = `
    ${isNew ? `<div class="card" style="box-shadow:none">
      <div class="row between"><div><strong>Comprovante</strong><div class="muted small">Tire uma foto ou envie o arquivo da nota de despesa, NF-e, cupom fiscal ou nota de serviço${meta.ocr_enabled ? ' — os campos serão preenchidos automaticamente.' : '.'}</div></div></div>
      <div class="row" style="margin-top:.6rem">
        <label class="btn primary"><input type="file" accept="image/*" capture="environment" data-up="camera" hidden>📷 Fotografar</label>
        <label class="btn"><input type="file" accept="image/*,application/pdf" data-up="file" hidden>📎 Enviar arquivo</label>
        <span data-upstatus class="muted small"></span>
      </div>
      <div data-files class="thumbs" style="margin-top:.6rem"></div>
      <div data-ocrmsg></div>
    </div>` : ''}
    ${opts.users ? `<label class="f">Colaborador<select name="user_id">${opts.users.map((u) => `<option value="${u.id}" ${u.id === (e.user_id || session.me.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
    <div class="form-grid">
      <label class="f">Data *<input type="date" name="expense_date" value="${esc(e.expense_date || today())}" max="${today()}" ${dis('expense_date')} required></label>
      <label class="f">Valor (R$) *<input type="number" name="amount" step="0.01" min="0.01" inputmode="decimal" value="${e.amount ?? ''}" ${dis('amount_cents')} required></label>
      <label class="f">Categoria *<select name="category_id" ${dis('category_id')} required>${catOptions(e.category_id)}</select></label>
      <label class="f">Forma de pagamento *<select name="payment_method" ${dis('payment_method')} required>${optionList(meta.payment_methods, e.payment_method, 'Selecione...')}</select></label>
      <label class="f">Tipo de documento *<select name="doc_type" ${dis('doc_type')} required>${optionList(meta.doc_types, e.doc_type || 'nfce')}</select></label>
      <label class="f">Nº do documento<input name="doc_number" value="${esc(e.doc_number || '')}" ${dis('doc_number')}></label>
      <label class="f span2">Fornecedor / estabelecimento<input name="supplier_name" value="${esc(e.supplier_name || '')}" ${dis('supplier_name')}></label>
      <label class="f">CNPJ/CPF do fornecedor<input name="supplier_doc" inputmode="numeric" value="${esc(fmtDoc(e.supplier_doc || ''))}" ${dis('supplier_doc')}></label>
      <label class="f">Cidade/UF<input name="city" value="${esc(e.city || '')}" ${dis('city')}></label>
      <label class="f">Centro de custo<input name="cost_center" value="${esc(e.cost_center ?? (isNew ? session.me.cost_center || '' : ''))}" ${dis('cost_center')}></label>
      ${opts.advances ? `<label class="f">Adiantamento vinculado<select name="advance_id" ${dis('advance_id')}><option value="">Nenhum</option>${opts.advances.map((a) => `<option value="${a.id}" ${String(e.advance_id) === String(a.id) ? 'selected' : ''}>#${a.id} — ${brl(a.amount)} — ${esc(a.purpose)}</option>`).join('')}</select></label>` : ''}
      <label class="f full">Chave de acesso (NF-e/NFC-e, 44 dígitos)<input name="access_key" inputmode="numeric" value="${esc(e.access_key || '')}" ${dis('access_key')}></label>
      <label class="f full">Descrição / justificativa<textarea name="description" ${dis('description')}>${esc(e.description || '')}</textarea></label>
      ${opts.reports?.length ? `<label class="f full">Incluir na prestação de contas<select name="report_id"><option value="">Não incluir agora</option>${opts.reports.map((r) => `<option value="${r.id}" ${String(opts.reportId) === String(r.id) ? 'selected' : ''}>#${r.id} — ${esc(r.title)}</option>`).join('')}</select></label>` : ''}
      ${opts.requireReason ? '<label class="f full">Justificativa da edição * <span class="muted small">(será enviada ao gestor junto com o antes/depois)</span><textarea name="reason" required></textarea></label>' : ''}
    </div>`;

  const uploaded = [];
  let ocrData = null;
  const filesBox = $('[data-files]', el);
  const status = $('[data-upstatus]', el);
  const ocrMsg = $('[data-ocrmsg]', el);

  const fill = (x) => {
    const set = (name, v) => { const inp = el.elements[name]; if (inp && v !== null && v !== undefined && v !== '') { inp.value = v; inp.classList.add('field-ai'); } };
    set('expense_date', x.expense_date);
    set('amount', x.total_amount);
    set('category_id', x.category_id);
    set('payment_method', x.payment_method);
    set('doc_type', x.doc_type);
    set('doc_number', x.doc_number);
    set('supplier_name', x.supplier_name);
    set('supplier_doc', fmtDoc(x.supplier_doc || ''));
    set('city', x.city);
    set('access_key', x.access_key);
    const items = (x.items || []).slice(0, 6).map((i) => i.description).join(', ');
    set('description', x.description + (items && !x.description.includes(items) ? ` (${items})` : ''));
  };

  $$('[data-up]', el).forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0];
    inp.value = '';
    if (!file) return;
    const first = uploaded.length === 0;
    status.innerHTML = `<span class="spinner"></span> ${first && meta.ocr_enabled ? 'Lendo o comprovante...' : 'Enviando...'}`;
    try {
      const r = await uploadReceipt(file, { ocr: first });
      uploaded.push(r.attachment);
      const t = document.createElement('button');
      t.type = 'button';
      t.title = `${r.attachment.original_name} — clique para remover`;
      t.innerHTML = r.attachment.mime === 'application/pdf' ? 'PDF' : `<img src="${fileUrl(r.attachment.id)}" alt="">`;
      t.onclick = async () => { await api(`/attachments/${r.attachment.id}`, { method: 'DELETE' }).catch(fail); uploaded.splice(uploaded.indexOf(r.attachment), 1); t.remove(); };
      filesBox.append(t);
      if (r.extraction) {
        ocrData = r.extraction;
        fill(r.extraction);
        const warn = r.extraction.warnings?.length ? `<br>Atenção: ${esc(r.extraction.warnings.join('; '))}` : '';
        ocrMsg.innerHTML = r.extraction.is_receipt
          ? `<div class="alert ${r.extraction.confidence === 'alta' ? 'good' : 'warn'}" style="margin-top:.6rem">Campos preenchidos automaticamente (confiança ${esc(r.extraction.confidence)}). Confira os campos destacados antes de salvar.${warn}</div>`
          : `<div class="alert warn" style="margin-top:.6rem">A imagem não parece ser um comprovante legível. Tente outra foto ou preencha manualmente.${warn}</div>`;
      } else if (r.extraction_error && first) {
        ocrMsg.innerHTML = `<div class="alert warn" style="margin-top:.6rem">${esc(r.extraction_error)}</div>`;
      }
      status.textContent = `${uploaded.length} arquivo(s) anexado(s)`;
    } catch (err) { status.textContent = ''; fail(err); }
  }));

  el.getData = () => {
    const f = el.elements;
    const v = (n) => (f[n] ? f[n].value : undefined);
    const data = {
      expense_date: v('expense_date'), amount: v('amount') === '' ? null : Number(v('amount')), category_id: v('category_id') || null,
      payment_method: v('payment_method'), doc_type: v('doc_type'), doc_number: v('doc_number'), supplier_name: v('supplier_name'),
      supplier_doc: v('supplier_doc'), city: v('city'), cost_center: v('cost_center'), access_key: v('access_key'), description: v('description'),
    };
    if (f.advance_id) data.advance_id = v('advance_id') || null;
    if (f.user_id) data.user_id = Number(v('user_id'));
    if (f.report_id) data.report_id = v('report_id') || null;
    if (f.reason) data.reason = v('reason');
    if (isNew) { data.attachment_ids = uploaded.map((a) => a.id); data.ocr_data = ocrData; }
    for (const k of Object.keys(data)) if (f[k]?.disabled) delete data[k];
    return data;
  };
  el.validate = () => {
    const d = el.getData();
    const errs = [];
    if (!d.expense_date && editable('expense_date')) errs.push('data');
    if ((!d.amount || d.amount <= 0) && editable('amount_cents')) errs.push('valor');
    if (!d.category_id && editable('category_id')) errs.push('categoria');
    if (!d.payment_method && editable('payment_method')) errs.push('forma de pagamento');
    if (opts.requireReason && !d.reason?.trim()) errs.push('justificativa da edição');
    if (d.access_key && d.access_key.replace(/\D/g, '').length !== 44) errs.push('chave de acesso com 44 dígitos');
    if (errs.length) { toast(`Preencha: ${errs.join(', ')}`, 'bad'); return null; }
    if (isNew && !uploaded.length) {
      const cat = meta.categories.find((c) => String(c.id) === String(d.category_id));
      if (cat?.requires_receipt && !confirm('Esta categoria exige comprovante. Salvar sem anexo mesmo assim?')) return null;
    }
    return d;
  };
  el.addEventListener('submit', (ev) => ev.preventDefault());
  return el;
}

// Abre a edição de uma despesa existente em modal (respeitando as permissões do perfil)
export async function openExpenseEdit(id, { onSaved, advances } = {}) {
  const e = await api(`/expenses/${id}`);
  if (!e.can_edit) { toast(e.edit_block_reason || 'Edição não permitida', 'bad'); return; }
  const requireReason = e.user_id !== session.me.id;
  const form = expenseForm({ expense: e, editableFields: e.editable_fields, requireReason, advances });
  const wrap = document.createElement('div');
  if (e.editable_fields !== 'all') wrap.innerHTML = '<div class="alert info" style="margin-bottom:.75rem">Como supervisor você pode alterar apenas alguns campos. Toda edição é registrada e notificada ao gestor com o antes e depois.</div>';
  else if (requireReason) wrap.innerHTML = '<div class="alert info" style="margin-bottom:.75rem">Toda edição é registrada e notificada ao gestor e ao colaborador com o antes e depois.</div>';
  wrap.append(form);
  modal({
    title: `Editar despesa #${e.id} — ${e.user_name}`, body: wrap, actions: [
      { label: 'Cancelar' },
      { label: 'Salvar alterações', kind: 'primary', onClick: async () => {
        const d = form.validate();
        if (!d) return false;
        await api(`/expenses/${e.id}`, { method: 'PUT', body: d });
        toast('Despesa atualizada', 'good');
        onSaved?.();
      } },
    ],
  });
}

export async function bootstrap() {
  session.meta = await api('/meta');
  session.me = await api('/me');
}

export function loginScreen(root, { title, subtitle, onLogin }) {
  root.innerHTML = `<div class="login-wrap"><div class="card login-card stack">
    <div class="brand"><span class="logo">R$</span>Despesas Corp</div>
    <div><h1>${esc(title)}</h1><div class="muted">${esc(subtitle)}</div></div>
    <form class="stack" id="lf">
      <label class="f">E-mail<input type="email" name="email" autocomplete="username" required></label>
      <label class="f">Senha<input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary" style="width:100%">Entrar</button>
    </form></div></div>`;
  $('#lf', root).onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      session.set(r.token);
      onLogin(r.user);
    } catch (e) { fail(e); }
  };
}
