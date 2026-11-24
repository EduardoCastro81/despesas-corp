'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');

const inbox = [];
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => { inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=') }); cb(); });
  },
});

let base;
let server;
let email;

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}
const login = (e, p) => call('POST', '/api/auth/login', { body: { email: e, password: p } });

test.before(async () => {
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'despesas-sec-'));
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.server.address().port);
  process.env.APP_URL = 'https://despesas.empresa.com';
  const app = require('../server/index');
  email = require('../server/services/email');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const m = (await login('admin@empresa.com', 'admin123')).body.token;
  await call('POST', '/api/users', { token: m, body: { name: 'Lia Colab', email: 'lia@t.com', role: 'colaborador', password: 'senhaforte1' } });
});
test.after(() => { server.close(); smtp.close(); });

test('login define cookie HttpOnly e o logout o remove', async () => {
  const r = await login('lia@t.com', 'senhaforte1');
  assert.strictEqual(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.match(c, /dc_session=/);
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Strict/i);
  assert.match(c, /Path=\/api/);
  const out = await call('POST', '/api/auth/logout');
  assert.match(out.headers.get('set-cookie'), /dc_session=;/);
});

test('política de senha', async () => {
  const m = (await login('admin@empresa.com', 'admin123')).body.token;
  const r = await call('POST', '/api/users', { token: m, body: { name: 'X', email: 'x@t.com', role: 'colaborador', password: 'curta' } });
  assert.strictEqual(r.status, 400);
  const r2 = await call('POST', '/api/users', { token: m, body: { name: 'X', email: 'x@t.com', role: 'colaborador', password: 'somenteletras' } });
  assert.strictEqual(r2.status, 400);
});

test('troca de senha encerra as outras sessões', async () => {
  const a = (await login('lia@t.com', 'senhaforte1')).body.token;
  const b = (await login('lia@t.com', 'senhaforte1')).body.token;
  const r = await call('POST', '/api/me/password', { token: a, body: { current: 'senhaforte1', password: 'novasenha2' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  assert.strictEqual((await call('GET', '/api/me', { token: b })).status, 401, 'sessão antiga encerrada');
  assert.strictEqual((await call('GET', '/api/me', { token: r.body.token })).status, 200, 'sessão atual continua');
  await call('POST', '/api/me/password', { token: r.body.token, body: { current: 'novasenha2', password: 'senhaforte1' } });
});

test('desativar usuário encerra a sessão dele', async () => {
  const m = (await login('admin@empresa.com', 'admin123')).body.token;
  const id = (await call('POST', '/api/users', { token: m, body: { name: 'Tmp', email: 'tmp@t.com', role: 'colaborador', password: 'senhaforte1' } })).body.id;
  const t = (await login('tmp@t.com', 'senhaforte1')).body.token;
  await call('PUT', `/api/users/${id}`, { token: m, body: { active: false } });
  assert.strictEqual((await call('GET', '/api/me', { token: t })).status, 401);
});

test('bloqueio após tentativas de login erradas', async () => {
  for (let i = 0; i < 5; i++) assert.strictEqual((await login('lia@t.com', 'errada')).status, 401);
  const r = await login('lia@t.com', 'senhaforte1');
  assert.strictEqual(r.status, 429, 'bloqueado mesmo com a senha certa');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  require('../server/services/ratelimit').loginByEmail.clear();
  assert.strictEqual((await login('lia@t.com', 'senhaforte1')).status, 200);
});

test('esqueci minha senha: link por e-mail, uso único e sessões encerradas', async () => {
  const old = (await login('lia@t.com', 'senhaforte1')).body.token;
  // e-mail inexistente: mesma resposta, nenhum e-mail
  const n = await call('POST', '/api/auth/forgot', { body: { email: 'naoexiste@t.com' } });
  assert.strictEqual(n.status, 200);
  const r = await call('POST', '/api/auth/forgot', { body: { email: 'LIA@t.com' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.message, n.body.message);
  await email.processQueue();
  const mails = inbox.filter((m) => m.to.includes('lia@t.com'));
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(inbox.filter((m) => m.to.includes('naoexiste@t.com')).length, 0);
  const token = mails[0].raw.match(/https:\/\/despesas\.empresa\.com\/app\/#\/redefinir\/([A-Za-z0-9_-]+)/)[1];
  assert.strictEqual((await call('POST', '/api/auth/reset', { body: { token, password: 'fraca' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/reset', { body: { token: 'invalido', password: 'outrasenha3' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/reset', { body: { token, password: 'outrasenha3' } })).status, 200);
  assert.strictEqual((await call('POST', '/api/auth/reset', { body: { token, password: 'outrasenha4' } })).status, 400, 'link de uso único');
  assert.strictEqual((await call('GET', '/api/me', { token: old })).status, 401, 'sessões antigas encerradas');
  assert.strictEqual((await login('lia@t.com', 'outrasenha3')).status, 200);
});

test('limite de pedidos de redefinição', async () => {
  require('../server/services/ratelimit').forgotByIp.clear();
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/forgot', { body: { email: 'a@t.com' } });
  assert.strictEqual((await call('POST', '/api/auth/forgot', { body: { email: 'a@t.com' } })).status, 429);
});
