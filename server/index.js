'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
require('./db');
const { HttpError } = require('./common');

const app = express();
app.disable('x-powered-by');
// Atrás de um proxy HTTPS (Render, Railway, Nginx, Caddy): TRUST_PROXY=1 para req.ip e cookies "secure" corretos
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/expenses'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/analytics'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Front-ends
const pub = path.join(__dirname, '..', 'public');
app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
app.use('/shared', express.static(path.join(pub, 'shared')));
app.use('/admin', express.static(path.join(pub, 'admin')));
app.use('/app', express.static(path.join(pub, 'app')));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

// Tratamento de erros
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 15 MB' : err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  require('./services/email').start();
  require('./services/backup').start();
  app.listen(PORT, () => {
    console.log(`Despesas Corp rodando em http://localhost:${PORT}`);
    console.log(`  Plataforma de administração: http://localhost:${PORT}/admin/`);
    console.log(`  Plataforma de lançamento:    http://localhost:${PORT}/app/`);
  });
}
module.exports = app;
