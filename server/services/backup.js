'use strict';
// Backup do banco (cópia consistente via VACUUM INTO) e dos comprovantes, com retenção.
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting, DATA_DIR, UPLOAD_DIR } = require('../db');

const backupDir = () => process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const keep = () => Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const enabled = () => process.env.BACKUP_ENABLED !== '0';
const hour = () => Number(process.env.BACKUP_HOUR ?? 2);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function runBackup() {
  const root = backupDir();
  let dest = path.join(root, `backup_${stamp()}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(root, `backup_${stamp()}-${i}`);
  const started = Date.now();
  try {
    fs.mkdirSync(dest, { recursive: true });
    const dbFile = path.join(dest, 'despesas.db');
    db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
    if (fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR, path.join(dest, 'uploads'), { recursive: true });
    const secret = path.join(DATA_DIR, '.jwt-secret');
    if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(dest, '.jwt-secret'));
    // Retenção: mantém os N backups mais recentes
    const all = fs.readdirSync(root).filter((n) => n.startsWith('backup_')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep()))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
    const size = dirSize(dest);
    const info = { ok: true, path: dest, size, seconds: Math.round((Date.now() - started) / 100) / 10, at: new Date().toISOString() };
    setSetting('backup_last', JSON.stringify(info));
    return info;
  } catch (e) {
    const info = { ok: false, error: e.message, at: new Date().toISOString() };
    setSetting('backup_last', JSON.stringify(info));
    console.error('[backup] falhou:', e.message);
    return info;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function status() {
  let last = null;
  try { last = JSON.parse(getSetting('backup_last') || 'null'); } catch { /* ignora */ }
  let count = 0;
  try { count = fs.readdirSync(backupDir()).filter((n) => n.startsWith('backup_')).length; } catch { /* sem pasta */ }
  return { enabled: enabled(), hour: hour(), dir: backupDir(), keep: keep(), count, last };
}

// Backup diário no horário configurado (verifica a cada 10 min)
function start() {
  if (!enabled()) return;
  const tick = () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (d.getHours() >= hour() && getSetting('backup_last_date') !== today) {
      setSetting('backup_last_date', today);
      const r = runBackup();
      if (r.ok) console.log(`[backup] concluído: ${r.path}`);
    }
  };
  const t = setInterval(tick, 10 * 60 * 1000);
  t.unref?.();
  setTimeout(tick, 30 * 1000).unref?.();
}

module.exports = { runBackup, status, start };
