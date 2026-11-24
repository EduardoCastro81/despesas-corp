'use strict';
// Avisos por e-mail: fila (email_outbox), envio via SMTP com novas tentativas e lembrete diário de aprovações.
const nodemailer = require('nodemailer');
const { one, all, run, getSetting, setSetting } = require('../db');

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60]; // minutos até a próxima tentativa
const ADMIN_ROLES = ['master', 'gestor', 'supervisor'];

let transporter = null;
let transporterKey = '';

function smtpConfig() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    tls: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === 'false' ? { rejectUnauthorized: false } : undefined,
  };
}
const isConfigured = () => Boolean(process.env.SMTP_HOST);
const isEnabled = () => isConfigured() && getSetting('email_enabled') === '1';
const fromAddress = () => process.env.MAIL_FROM || process.env.SMTP_USER || 'despesas@localhost';
const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

function getTransporter() {
  const cfg = smtpConfig();
  const key = JSON.stringify(cfg);
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport(cfg);
    transporterKey = key;
  }
  return transporter;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Link absoluto para a plataforma certa conforme o perfil do destinatário
function absoluteLink(link, role) {
  if (!link) return null;
  const platform = ADMIN_ROLES.includes(role) ? 'admin' : 'app';
  return `${appUrl()}/${platform}/${link.startsWith('#') ? link : `#${link}`}`;
}

function layout({ title, intro, content = '', button, footer }) {
  const company = getSetting('company_name');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#16181d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e5ea;border-radius:10px">
<tr><td style="padding:18px 22px;border-bottom:1px solid #e2e5ea;font-weight:700;font-size:15px"><span style="display:inline-block;background:#1f5fbf;color:#fff;border-radius:6px;padding:2px 7px;margin-right:6px">R$</span>Despesas Corp <span style="color:#7d8294;font-weight:400">· ${esc(company)}</span></td></tr>
<tr><td style="padding:22px">
<h1 style="font-size:18px;margin:0 0 10px">${esc(title)}</h1>
${intro ? `<p style="margin:0 0 14px;white-space:pre-line;line-height:1.5">${esc(intro)}</p>` : ''}
${content}
${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.href)}" style="background:#1f5fbf;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600">${esc(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 22px;border-top:1px solid #e2e5ea;color:#7d8294;font-size:12px">${footer || 'Aviso automático do sistema de prestação de contas. Para deixar de receber e-mails, desative a opção em Perfil.'}</td></tr>
</table></td></tr></table></body></html>`;
}

function changesTable(changes) {
  if (!changes?.length) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 4px">
<tr><th align="left" style="padding:6px 8px;background:#f8f9fb;border:1px solid #e2e5ea">Campo</th><th align="left" style="padding:6px 8px;background:#f8f9fb;border:1px solid #e2e5ea">Antes</th><th align="left" style="padding:6px 8px;background:#f8f9fb;border:1px solid #e2e5ea">Depois</th></tr>
${changes.map((c) => `<tr><td style="padding:6px 8px;border:1px solid #e2e5ea">${esc(c.label)}</td><td style="padding:6px 8px;border:1px solid #e2e5ea;color:#b42323;text-decoration:line-through">${esc(c.before)}</td><td style="padding:6px 8px;border:1px solid #e2e5ea;color:#137a3a;font-weight:600">${esc(c.after)}</td></tr>`).join('')}
</table>`;
}

function enqueue({ userId = null, to, subject, html, text, type = null }) {
  run('INSERT INTO email_outbox(user_id, to_email, subject, html, text, type) VALUES(?,?,?,?,?,?)', userId, to, subject, html, text, type);
  scheduleProcess();
}

// Chamado por notify(): transforma uma notificação do sistema em e-mail, se aplicável
function queueNotificationEmail(userId, { type, title, body, link, data }) {
  if (!isEnabled()) return;
  const types = JSON.parse(getSetting('email_types') || '[]');
  if (!types.includes(type)) return;
  const u = one('SELECT email, name, role, active, email_notifications FROM users WHERE id = ?', userId);
  if (!u || !u.active || !u.email_notifications) return;
  const href = absoluteLink(link, u.role);
  const changes = data?.changes;
  // Para edições, o corpo já traz o antes/depois em texto; no HTML mostramos em tabela
  const intro = changes ? (data.reason ? `Justificativa: ${data.reason}` : null) : body;
  const html = layout({
    title, intro: `Olá, ${u.name.split(' ')[0]}.${intro ? `\n${intro}` : ''}`,
    content: changesTable(changes), button: href ? { href, label: 'Abrir no sistema' } : null,
  });
  const text = `${title}\n\n${body || ''}${href ? `\n\nAbrir: ${href}` : ''}`;
  enqueue({ userId, to: u.email, subject: `[Despesas] ${title}`, html, text, type });
}

// ---------- Processamento da fila ----------
let current = null; // processamento em andamento
let timer = null;
function scheduleProcess() {
  if (timer || !isConfigured()) return;
  timer = setTimeout(() => { timer = null; processQueue().catch((e) => console.error('[email]', e.message)); }, 50);
  timer.unref?.();
}

// Se já houver um processamento em andamento, aguarda e processa de novo (pega itens novos)
async function processQueue() {
  if (!isConfigured()) return 0;
  while (current) await current.catch(() => {});
  current = runQueue();
  try { return await current; } finally { current = null; }
}

async function runQueue() {
  let sent = 0;
  {
    const batch = all(`SELECT * FROM email_outbox WHERE status = 'pendente' AND next_attempt_at <= datetime('now','localtime') ORDER BY id LIMIT 50`);
    for (const m of batch) {
      try {
        await getTransporter().sendMail({ from: fromAddress(), to: m.to_email, subject: m.subject, html: m.html, text: m.text });
        run(`UPDATE email_outbox SET status = 'enviado', sent_at = datetime('now','localtime'), attempts = attempts + 1, last_error = NULL WHERE id = ?`, m.id);
        sent++;
      } catch (err) {
        const attempts = m.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS;
        const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
        run(`UPDATE email_outbox SET attempts = ?, last_error = ?, status = ?, next_attempt_at = datetime('now','localtime', ?) WHERE id = ?`,
          attempts, String(err.message).slice(0, 500), final ? 'erro' : 'pendente', `+${wait} minutes`, m.id);
        console.error(`[email] falha ao enviar #${m.id} para ${m.to_email}: ${err.message}`);
      }
    }
  }
  return sent;
}

// ---------- Lembrete diário de aprovações pendentes ----------
function localDate() {
  const d = new Date();
  return { date: new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10), hour: d.getHours() };
}

function pendingByApprover() {
  const out = new Map(); // userId -> { user, items: [] }
  const add = (u, r) => {
    if (!out.has(u.id)) out.set(u.id, { user: u, items: [] });
    out.get(u.id).items.push(r);
  };
  const reports = all(`SELECT r.id, r.title, r.status, r.submitted_at, u.name AS user_name, u.supervisor_id,
      (SELECT COALESCE(SUM(amount_cents),0) FROM expenses e WHERE e.report_id = r.id AND e.status <> 'glosada') AS total_cents
    FROM reports r JOIN users u ON u.id = r.user_id WHERE r.status IN ('aguardando_supervisor','aguardando_gestor','aprovada') ORDER BY r.submitted_at`);
  const managers = all(`SELECT id, name, email, role, email_notifications, active FROM users WHERE role = 'gestor' AND active = 1`);
  const approvers = managers.length ? managers : all(`SELECT id, name, email, role, email_notifications, active FROM users WHERE role = 'master' AND active = 1`);
  for (const r of reports) {
    if (r.status === 'aguardando_supervisor') {
      const s = one('SELECT id, name, email, role, email_notifications, active FROM users WHERE id = ?', r.supervisor_id);
      if (s && s.active) add(s, r);
    } else {
      for (const m of approvers) add(m, r);
    }
  }
  return out;
}

function sendDailyReminders({ force = false } = {}) {
  if (!isEnabled()) return 0;
  const hourSetting = getSetting('reminder_hour');
  if (hourSetting === '' || hourSetting === null || hourSetting === undefined) { if (!force) return 0; }
  const { date, hour } = localDate();
  if (!force && (getSetting('reminder_last_date') === date || hour < Number(hourSetting))) return 0;
  setSetting('reminder_last_date', date);
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const label = { aguardando_supervisor: 'Aguardando sua aprovação', aguardando_gestor: 'Aguardando aprovação final', aprovada: 'Aprovada — aguardando pagamento' };
  let n = 0;
  for (const { user, items } of pendingByApprover().values()) {
    if (!user.email_notifications) continue;
    const total = items.reduce((s, r) => s + r.total_cents, 0);
    const rows = items.map((r) => `<tr><td style="padding:6px 8px;border:1px solid #e2e5ea">#${r.id} ${esc(r.title)}<br><span style="color:#7d8294;font-size:12px">${esc(r.user_name)} · enviada em ${esc((r.submitted_at || '').slice(0, 10).split('-').reverse().join('/'))}</span></td>
      <td style="padding:6px 8px;border:1px solid #e2e5ea;font-size:13px">${esc(label[r.status])}</td><td align="right" style="padding:6px 8px;border:1px solid #e2e5ea;white-space:nowrap">${brl(r.total_cents)}</td></tr>`).join('');
    const title = `${items.length} prestação(ões) de contas pendente(s)`;
    enqueue({
      userId: user.id, to: user.email, type: 'lembrete_diario', subject: `[Despesas] Lembrete: ${title}`,
      html: layout({
        title, intro: `Olá, ${user.name.split(' ')[0]}. Estas prestações de contas aguardam sua ação (total ${brl(total)}):`,
        content: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`,
        button: { href: `${appUrl()}/admin/#/prestacoes`, label: 'Ver prestações pendentes' },
      }),
      text: `${title}\n\n${items.map((r) => `#${r.id} ${r.title} (${r.user_name}) — ${label[r.status]} — ${brl(r.total_cents)}`).join('\n')}\n\nAbrir: ${appUrl()}/admin/#/prestacoes`,
    });
    n++;
  }
  return n;
}

function sendTest(to) {
  if (!isConfigured()) throw new Error('SMTP não configurado no servidor');
  return getTransporter().sendMail({
    from: fromAddress(), to, subject: '[Despesas] Teste de envio de e-mail',
    html: layout({ title: 'Teste de envio', intro: 'Se você recebeu esta mensagem, os avisos por e-mail estão funcionando.' }),
    text: 'Se você recebeu esta mensagem, os avisos por e-mail estão funcionando.',
  });
}

function start() {
  if (!isConfigured()) return;
  const t = setInterval(() => {
    try { sendDailyReminders(); } catch (e) { console.error('[email] lembrete', e.message); }
    processQueue().catch((e) => console.error('[email]', e.message));
  }, 60000);
  t.unref?.();
  scheduleProcess();
}

module.exports = { isConfigured, isEnabled, queueNotificationEmail, processQueue, sendDailyReminders, sendTest, start, fromAddress, appUrl };
