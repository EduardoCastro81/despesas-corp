'use strict';
// Uso: npm run backup  (gera um backup imediato do banco e dos comprovantes)
const { runBackup } = require('./services/backup');

const r = runBackup();
if (r.ok) {
  console.log(`Backup concluído em ${r.path} (${(r.size / 1048576).toFixed(1)} MB, ${r.seconds}s)`);
} else {
  console.error(`Falha no backup: ${r.error}`);
  process.exit(1);
}
