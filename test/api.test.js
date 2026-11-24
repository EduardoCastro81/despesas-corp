'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'despesas-test-'));
delete process.env.ANTHROPIC_API_KEY;
const app = require('../server/index');

let base;
let server;
const tokens = {};
const ids = {};

async function call(who, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const login = async (who, email, password) => {
  const r = await call(null, 'POST', '/api/auth/login', { email, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  tokens[who] = r.body.token;
};
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('cadastro de perfis e equipe', async () => {
  await login('master', 'admin@empresa.com', 'admin123');
  const mk = async (who, b) => { const r = await call(who, 'POST', '/api/users', { password: 'senha123', ...b }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body.id; };
  ids.gestor = await mk('master', { name: 'Gestor', email: 'g@t.com', role: 'gestor' });
  await login('gestor', 'g@t.com', 'senha123');
  // gestor não pode criar master/gestor
  assert.strictEqual((await call('gestor', 'POST', '/api/users', { name: 'X', email: 'x@t.com', role: 'gestor', password: 'senha123' })).status, 403);
  ids.sup = await mk('gestor', { name: 'Supervisor', email: 's@t.com', role: 'supervisor', supervisor_id: ids.gestor });
  ids.colab = await mk('gestor', { name: 'Colab', email: 'c@t.com', role: 'colaborador', supervisor_id: ids.sup, cost_center: 'CC1' });
  ids.outro = await mk('gestor', { name: 'Outro', email: 'o@t.com', role: 'colaborador' });
  await login('sup', 's@t.com', 'senha123');
  await login('colab', 'c@t.com', 'senha123');
  await login('outro', 'o@t.com', 'senha123');
});

test('lançamento de despesas e visibilidade por perfil', async () => {
  const meta = (await call('colab', 'GET', '/api/meta')).body;
  ids.catAlim = meta.categories.find((c) => c.name === 'Alimentação').id;
  ids.catRep = meta.categories.find((c) => c.name.startsWith('Representação')).id;
  const e = { expense_date: daysAgo(2), amount: 89.9, category_id: ids.catAlim, payment_method: 'cartao_corporativo', doc_type: 'nfce', supplier_name: 'Restaurante X', doc_number: '123' };
  let r = await call('colab', 'POST', '/api/expenses', e);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  ids.e1 = r.body.id;
  assert.strictEqual(r.body.cost_center, 'CC1');
  r = await call('colab', 'POST', '/api/expenses', { ...e, amount: 250, doc_number: '124', supplier_name: 'Churrascaria' });
  ids.e2 = r.body.id;
  assert.strictEqual(r.body.over_limit, 1, 'acima do limite da categoria');
  // validações
  assert.strictEqual((await call('colab', 'POST', '/api/expenses', { ...e, amount: 0 })).status, 400);
  assert.strictEqual((await call('colab', 'POST', '/api/expenses', { ...e, payment_method: 'x' })).status, 400);
  // escopo
  assert.strictEqual((await call('outro', 'GET', `/api/expenses/${ids.e1}`)).status, 404);
  assert.strictEqual((await call('sup', 'GET', `/api/expenses/${ids.e1}`)).status, 200);
  const list = (await call('gestor', 'GET', `/api/expenses?user_id=${ids.colab}&category_id=${ids.catAlim}&payment_method=cartao_corporativo&has_advance=0`)).body;
  assert.strictEqual(list.count, 2);
});

test('upload sem chave de API retorna aviso de leitura automática', async () => {
  const fd = new FormData();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fd.append('file', new Blob([png], { type: 'image/png' }), 'nota.png');
  const res = await fetch(`${base}/api/uploads?ocr=1`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.colab}` }, body: fd });
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assert.ok(body.attachment.id);
  assert.match(body.extraction_error, /não configurada/);
  ids.att = body.attachment.id;
  const r = await call('colab', 'PUT', `/api/expenses/${ids.e1}`, { attachment_ids: [ids.att] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.attachment_count, 1);
  const f = await fetch(`${base}/api/files/${ids.att}?token=${tokens.sup}`);
  assert.strictEqual(f.status, 200);
  assert.strictEqual((await fetch(`${base}/api/files/${ids.att}?token=${tokens.outro}`)).status, 404);
});

test('adiantamento: solicitação, aprovação e pagamento', async () => {
  let r = await call('colab', 'POST', '/api/advances', { amount: 300, purpose: 'Viagem' });
  assert.strictEqual(r.body.status, 'solicitado');
  ids.adv = r.body.id;
  assert.strictEqual((await call('colab', 'POST', `/api/advances/${ids.adv}/approve`)).status, 403);
  r = await call('gestor', 'POST', `/api/advances/${ids.adv}/pay`, {});
  assert.strictEqual(r.body.status, 'pago');
});

test('fluxo de aprovação com edição do supervisor notificada ao gestor', async () => {
  let r = await call('colab', 'POST', '/api/reports', { title: 'Viagem', period_start: daysAgo(5), period_end: daysAgo(0), advance_id: ids.adv, expense_ids: [ids.e1, ids.e2] });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  ids.rep = r.body.id;
  // envio exige confirmação de comprovantes faltantes
  r = await call('colab', 'POST', `/api/reports/${ids.rep}/submit`, {});
  assert.strictEqual(r.status, 409);
  r = await call('colab', 'POST', `/api/reports/${ids.rep}/submit`, { confirm_missing_receipts: true });
  assert.strictEqual(r.body.status, 'aguardando_supervisor');
  // colaborador não edita mais
  assert.strictEqual((await call('colab', 'PUT', `/api/expenses/${ids.e1}`, { description: 'x' })).status, 403);
  // supervisor: campo não permitido (valor)
  assert.strictEqual((await call('sup', 'PUT', `/api/expenses/${ids.e2}`, { amount: 10, reason: 'teste' })).status, 403);
  // supervisor: sem justificativa
  assert.strictEqual((await call('sup', 'PUT', `/api/expenses/${ids.e2}`, { category_id: ids.catRep })).status, 400);
  r = await call('sup', 'PUT', `/api/expenses/${ids.e2}`, { category_id: ids.catRep, reason: 'Almoço com cliente' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const notes = (await call('gestor', 'GET', '/api/notifications')).body.items;
  const n = notes.find((x) => x.type === 'edicao_despesa' && x.data?.expense_id === ids.e2);
  assert.ok(n, 'gestor notificado');
  assert.deepStrictEqual(n.data.changes[0], { field: 'category_id', label: 'Categoria', before: 'Alimentação', after: 'Representação/clientes' });
  assert.strictEqual(n.data.reason, 'Almoço com cliente');
  assert.ok((await call('colab', 'GET', '/api/notifications')).body.items.some((x) => x.type === 'edicao_despesa'), 'colaborador notificado');
  // auditoria
  const audit = (await call('gestor', 'GET', `/api/audit?expense_id=${ids.e2}`)).body;
  assert.strictEqual(audit[0].editor_role, 'supervisor');
  // outro usuário não aprova; colaborador não aprova a própria
  assert.strictEqual((await call('colab', 'POST', `/api/reports/${ids.rep}/approve`, {})).status, 403);
  // supervisor glosa um item e aprova
  r = await call('sup', 'POST', `/api/expenses/${ids.e2}/review`, { action: 'glosar', reason: 'Fora da política' });
  assert.strictEqual(r.body.status, 'glosada');
  r = await call('sup', 'POST', `/api/reports/${ids.rep}/approve`, { comment: 'ok' });
  assert.strictEqual(r.body.status, 'aguardando_gestor');
  assert.strictEqual((await call('sup', 'POST', `/api/reports/${ids.rep}/approve`, {})).status, 403);
  // gestor devolve, colaborador ajusta e reenvia
  r = await call('gestor', 'POST', `/api/reports/${ids.rep}/return`, { comment: 'Ajustar descrição' });
  assert.strictEqual(r.body.status, 'devolvida');
  r = await call('colab', 'PUT', `/api/expenses/${ids.e1}`, { description: 'Almoço na viagem' });
  assert.strictEqual(r.status, 200);
  r = await call('colab', 'POST', `/api/reports/${ids.rep}/submit`, { confirm_missing_receipts: true });
  assert.strictEqual(r.body.status, 'aguardando_supervisor');
  await call('sup', 'POST', `/api/reports/${ids.rep}/approve`, {});
  r = await call('gestor', 'POST', `/api/reports/${ids.rep}/approve`, {});
  assert.strictEqual(r.body.status, 'aprovada');
  // saldo: aprovado 89,90 - adiantamento 300 = colaborador devolve 210,10
  assert.strictEqual(r.body.approved_total, 89.9);
  assert.strictEqual(r.body.balance, -210.1);
  r = await call('gestor', 'POST', `/api/reports/${ids.rep}/finalize`, { note: 'Devolução recebida' });
  assert.strictEqual(r.body.status, 'finalizada');
  const adv = (await call('gestor', 'GET', '/api/advances')).body.find((a) => a.id === ids.adv);
  assert.strictEqual(adv.status, 'liquidado');
  // filtro "com adiantamento"
  const withAdv = (await call('gestor', 'GET', '/api/expenses?has_advance=1')).body;
  assert.strictEqual(withAdv.count, 2);
  // gestor não edita prestação finalizada
  assert.strictEqual((await call('gestor', 'PUT', `/api/expenses/${ids.e1}`, { description: 'x', reason: 'y' })).status, 403);
});

test('alçada do supervisor aprova em definitivo', async () => {
  await call('gestor', 'PUT', '/api/settings', { supervisor_approval_limit_cents: 50000 });
  const e = (await call('colab', 'POST', '/api/expenses', { expense_date: daysAgo(1), amount: 40, category_id: ids.catAlim, payment_method: 'pix', doc_type: 'recibo' })).body;
  const rp = (await call('colab', 'POST', '/api/reports', { title: 'Pequena', expense_ids: [e.id] })).body;
  await call('colab', 'POST', `/api/reports/${rp.id}/submit`, { confirm_missing_receipts: true });
  const r = await call('sup', 'POST', `/api/reports/${rp.id}/approve`, {});
  assert.strictEqual(r.body.status, 'aprovada');
});

test('relatórios e exportação', async () => {
  const s = (await call('gestor', 'GET', '/api/analytics/summary')).body;
  assert.ok(s.kpis.count >= 3);
  assert.ok(s.by_category.length >= 1);
  assert.ok(s.by_payment.length >= 1);
  assert.ok(s.by_advance.find((x) => x.key === 'sim'));
  const sup = (await call('sup', 'GET', '/api/analytics/summary')).body;
  assert.ok(sup.kpis.count >= 3);
  assert.strictEqual((await call('colab', 'GET', '/api/analytics/summary')).status, 403);
  const m = (await call('gestor', 'GET', '/api/analytics/matrix')).body;
  assert.ok(m.rows.length);
  const csv = await fetch(`${base}/api/expenses/export?format=csv`, { headers: { Authorization: `Bearer ${tokens.gestor}` } });
  assert.match(await csv.text(), /Colaborador;Categoria/);
  const x = await fetch(`${base}/api/expenses/export?format=xlsx`, { headers: { Authorization: `Bearer ${tokens.gestor}` } });
  assert.strictEqual(x.status, 200);
  assert.ok((await x.arrayBuffer()).byteLength > 1000);
  const p = await call(null, 'GET', `/api/reports/${ids.rep}/print?token=${tokens.colab}`);
  assert.match(p.body, /A devolver pelo colaborador/);
});
