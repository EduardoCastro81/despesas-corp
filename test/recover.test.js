'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Cada cenário roda num processo novo, como um reinício do servidor no Render
function boot(dataDir, env) {
  const script = `
    const app = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'index.js'))});
    const s = app.listen(0, async () => {
      const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.T_EMAIL, password: process.env.T_PASS }) });
      const b = await r.json();
      console.log('RESULT ' + r.status + ' ' + (b.user ? b.user.role : ''));
      process.exit(0);
    });`;
  const p = spawnSync(process.execPath, ['--no-warnings', '-e', script], {
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'production', ...env }, encoding: 'utf8',
  });
  const out = p.stdout + p.stderr;
  return { out, result: out.match(/RESULT (\d+) ?(\w*)/).slice(1) };
}

test('recupera o acesso do master sem perder dados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'despesas-recover-'));
  // 1ª execução em produção sem senha: gera senha aleatória (desconhecida)
  let r = boot(dir, { MASTER_EMAIL: 'dono@empresa.com', T_EMAIL: 'dono@empresa.com', T_PASS: 'qualquer1' });
  assert.strictEqual(r.result[0], '401');
  // senha fraca é ignorada
  r = boot(dir, { MASTER_EMAIL: 'dono@empresa.com', MASTER_RESET_PASSWORD: 'fraca', T_EMAIL: 'dono@empresa.com', T_PASS: 'fraca' });
  assert.match(r.out, /ignorada/);
  assert.strictEqual(r.result[0], '401');
  // redefinição
  r = boot(dir, { MASTER_EMAIL: 'dono@empresa.com', MASTER_RESET_PASSWORD: 'Recupera2026', T_EMAIL: 'dono@empresa.com', T_PASS: 'Recupera2026' });
  assert.match(r.out, /Acesso do master redefinido para dono@empresa.com/);
  assert.deepStrictEqual(r.result, ['200', 'master']);
  // após remover a variável, a senha continua valendo
  r = boot(dir, { MASTER_EMAIL: 'dono@empresa.com', T_EMAIL: 'dono@empresa.com', T_PASS: 'Recupera2026' });
  assert.deepStrictEqual(r.result, ['200', 'master']);
  // e-mail diferente do master existente: cria um novo master
  r = boot(dir, { MASTER_EMAIL: 'outro@empresa.com', MASTER_RESET_PASSWORD: 'Recupera2026', T_EMAIL: 'outro@empresa.com', T_PASS: 'Recupera2026' });
  assert.deepStrictEqual(r.result, ['200', 'master']);
});
