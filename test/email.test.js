'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');

const inbox = [];
let smtpFail = false;
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  logger: false,
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => {
      if (smtpFail) return cb(new Error('Caixa indisponível'));
      inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: decode(raw) });
      cb();
    });
  },
});
// Decodifica quoted-printable para facilitar as asserções
const decode = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

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
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (who, email, password) => { tokens[who] = (await call(null, 'POST', '/api/auth/login', { email, password })).body.token; };
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const mailsTo = (addr) => inbox.filter((m) => m.to.includes(addr));
let email;
const flush = async () => { await new Promise((r) => setTimeout(r, 100)); await email.processQueue(); };

test.before(async () => {
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'despesas-email-'));
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.server.address().port);
  process.env.MAIL_FROM = 'Despesas <despesas@empresa.com>';
  process.env.APP_URL = 'https://despesas.empresa.com';
  delete process.env.ANTHROPIC_API_KEY;
  const app = require('../server/index');
  email = require('../server/services/email');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await login('master', 'admin@empresa.com', 'admin123');
  const mk = async (b) => (await call('master', 'POST', '/api/users', { password: 'senha123', ...b })).body.id;
  ids.gestor = await mk({ name: 'Gina Gestora', email: 'gestor@t.com', role: 'gestor' });
  ids.sup = await mk({ name: 'Sara Supervisora', email: 'sup@t.com', role: 'supervisor', supervisor_id: ids.gestor });
  ids.colab = await mk({ name: 'Caio Colab', email: 'colab@t.com', role: 'colaborador', supervisor_id: ids.sup });
  for (const [k, e] of [['gestor', 'gestor@t.com'], ['sup', 'sup@t.com'], ['colab', 'colab@t.com']]) await login(k, e, 'senha123');
  const meta = (await call('colab', 'GET', '/api/meta')).body;
  ids.catAlim = meta.categories.find((c) => c.name === 'Alimentação').id;
  ids.catRep = meta.categories.find((c) => c.name.startsWith('Representação')).id;
});
test.after(() => { server.close(); smtp.close(); });

test('envio para aprovação avisa o supervisor por e-mail com link para a administração', async () => {
  const e = (await call('colab', 'POST', '/api/expenses', { expense_date: daysAgo(1), amount: 120, category_id: ids.catAlim, payment_method: 'pix', doc_type: 'nfce', supplier_name: 'Restaurante' })).body;
  ids.exp = e.id;
  ids.rep = (await call('colab', 'POST', '/api/reports', { title: 'Viagem RJ', expense_ids: [e.id] })).body.id;
  await call('colab', 'POST', `/api/reports/${ids.rep}/submit`, { confirm_missing_receipts: true });
  await flush();
  const m = mailsTo('sup@t.com');
  assert.strictEqual(m.length, 1);
  assert.match(m[0].raw, /Subject: .*Presta/);
  assert.match(m[0].raw, new RegExp(`https://despesas.empresa.com/admin/#/prestacao/${ids.rep}`));
});

test('edição do supervisor envia ao gestor o antes e depois', async () => {
  await call('sup', 'PUT', `/api/expenses/${ids.exp}`, { category_id: ids.catRep, reason: 'Almoço com cliente' });
  await flush();
  const m = mailsTo('gestor@t.com').find((x) => x.raw.includes('editou a despesa'));
  assert.ok(m, 'gestor recebeu e-mail de edição');
  assert.match(m.raw, /Alimenta(ç|=C3=A7|\xC3\xA7)/);
  assert.ok(m.raw.includes('Representa'), 'valor depois');
  assert.ok(m.raw.includes('Almo'), 'justificativa');
  // o colaborador também é avisado, com link para a plataforma de lançamento
  const c = mailsTo('colab@t.com').find((x) => x.raw.includes('foi editada'));
  assert.ok(c);
  assert.match(c.raw, /https:\/\/despesas\.empresa\.com\/app\/#\/despesa\//);
});

test('usuário que desativou e-mails não recebe; tipo desativado não é enviado', async () => {
  await call('colab', 'PUT', '/api/me/preferences', { email_notifications: false });
  const before = mailsTo('colab@t.com').length;
  await call('sup', 'POST', `/api/reports/${ids.rep}/return`, { comment: 'Ajustar' });
  await flush();
  assert.strictEqual(mailsTo('colab@t.com').length, before);
  assert.ok((await call('colab', 'GET', '/api/notifications')).body.items.some((n) => n.title.includes('devolvida')), 'aviso no sistema continua');
  await call('colab', 'PUT', '/api/me/preferences', { email_notifications: true });

  await call('gestor', 'PUT', '/api/settings', { email_types: ['prestacao_status'] });
  const sup = mailsTo('sup@t.com').length;
  await call('colab', 'POST', `/api/reports/${ids.rep}/submit`, { confirm_missing_receipts: true });
  await flush();
  assert.strictEqual(mailsTo('sup@t.com').length, sup, 'aprovacao_pendente desativado');
  await call('gestor', 'PUT', '/api/settings', { email_types: ['edicao_despesa', 'exclusao_despesa', 'aprovacao_pendente', 'aprovada_alcada', 'prestacao_status', 'glosa', 'adiantamento', 'despesa_lancada'] });
});

test('lembrete diário lista as prestações pendentes de cada aprovador', async () => {
  const r = await call('gestor', 'POST', '/api/email/reminders');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.recipients >= 1);
  const m = mailsTo('sup@t.com').find((x) => x.raw.includes('Lembrete'));
  assert.ok(m);
  assert.ok(m.raw.includes('Viagem RJ'));
  assert.strictEqual(email.sendDailyReminders(), 0, 'não repete no mesmo dia');
});

test('falha no SMTP fica na fila e é reenviada', async () => {
  smtpFail = true;
  await call('gestor', 'POST', '/api/advances', { user_id: ids.colab, amount: 100, purpose: 'Teste' });
  await flush();
  let log = (await call('gestor', 'GET', '/api/email/log')).body;
  const failed = log.items.find((x) => x.status === 'pendente' && x.last_error);
  assert.ok(failed, 'registrado com erro');
  smtpFail = false;
  const r = await call('gestor', 'POST', `/api/email/log/${failed.id}/retry`);
  assert.strictEqual(r.body.status, 'enviado');
  log = (await call('gestor', 'GET', '/api/email/log')).body;
  assert.ok(log.counts.enviado >= 4);
});

test('e-mail de teste e permissões', async () => {
  const t = await call('gestor', 'POST', '/api/email/test', { to: 'teste@t.com' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(mailsTo('teste@t.com').length);
  assert.strictEqual((await call('colab', 'POST', '/api/email/test', { to: 'x@t.com' })).status, 403);
  assert.strictEqual((await call('colab', 'GET', '/api/email/log')).status, 403);
  assert.strictEqual((await call('gestor', 'POST', '/api/email/test', { to: 'invalido' })).status, 400);
});
