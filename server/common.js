'use strict';
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { one, all, DATA_DIR } = require('./db');

// ---------- Constantes de domínio ----------
const ROLES = {
  master: 'Administrador Master',
  gestor: 'Gestor',
  supervisor: 'Supervisor',
  colaborador: 'Colaborador',
};
const PAYMENT_METHODS = {
  dinheiro: 'Dinheiro',
  cartao_corporativo: 'Cartão corporativo',
  cartao_pessoal: 'Cartão pessoal',
  pix: 'PIX',
  transferencia: 'Transferência',
  faturado: 'Faturado (empresa)',
  adiantamento: 'Adiantamento (verba)',
};
const DOC_TYPES = {
  nfe: 'Nota fiscal (NF-e)',
  nfce: 'Cupom fiscal / NFC-e',
  nfse: 'Nota de serviço (NFS-e)',
  recibo: 'Nota de despesa / recibo',
  outro: 'Outro / sem comprovante fiscal',
};
const EXPENSE_STATUS = { rascunho: 'Rascunho', em_analise: 'Em análise', aprovada: 'Aprovada', glosada: 'Glosada' };
const REPORT_STATUS = {
  rascunho: 'Rascunho',
  aguardando_supervisor: 'Aguardando supervisor',
  aguardando_gestor: 'Aguardando gestor',
  devolvida: 'Devolvida p/ ajuste',
  aprovada: 'Aprovada',
  rejeitada: 'Rejeitada',
  finalizada: 'Finalizada (paga/liquidada)',
};
const ADVANCE_STATUS = { solicitado: 'Solicitado', aprovado: 'Aprovado', pago: 'Pago', rejeitado: 'Rejeitado', liquidado: 'Liquidado' };

// Rótulos dos campos editáveis de uma despesa (para o diff antes/depois)
const EXPENSE_FIELDS = {
  expense_date: 'Data',
  amount_cents: 'Valor',
  category_id: 'Categoria',
  payment_method: 'Forma de pagamento',
  doc_type: 'Tipo de documento',
  doc_number: 'Nº do documento',
  access_key: 'Chave de acesso',
  supplier_name: 'Fornecedor',
  supplier_doc: 'CNPJ/CPF do fornecedor',
  description: 'Descrição',
  city: 'Cidade/UF',
  cost_center: 'Centro de custo',
  advance_id: 'Adiantamento vinculado',
};

// ---------- Erros HTTP ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Acesso negado') => new HttpError(403, m);
const notFound = (m = 'Registro não encontrado') => new HttpError(404, m);

// ---------- Autenticação ----------
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
const SECRET = loadSecret();

const SESSION_HOURS = 12;
const COOKIE_NAME = 'dc_session';

// token_version (tv) permite encerrar todas as sessões de um usuário (troca de senha, desativação)
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.token_version || 0 }, SECRET, { expiresIn: `${SESSION_HOURS}h` });
}

// Cookie HttpOnly usado apenas para carregar comprovantes (<img>) e a página de impressão,
// para que o token de sessão nunca apareça em URLs, históricos ou logs.
function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api', maxAge: SESSION_HOURS * 3600 * 1000,
  });
}
function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api' });
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// Rotas somente-leitura que aceitam o cookie (carregadas pelo navegador sem cabeçalho Authorization)
const COOKIE_ROUTES = /^\/api\/(files\/\d+|reports\/\d+\/print)(\?|$)/;

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token && req.method === 'GET' && COOKIE_ROUTES.test(req.originalUrl)) token = readCookie(req, COOKIE_NAME);
  if (!token) return next(new HttpError(401, 'Não autenticado'));
  try {
    const payload = jwt.verify(token, SECRET);
    const u = one('SELECT id, name, email, role, supervisor_id, cost_center, department, active, email_notifications, token_version FROM users WHERE id = ?', payload.sub);
    if (!u || !u.active) return next(new HttpError(401, 'Usuário inativo'));
    if ((payload.tv || 0) !== (u.token_version || 0)) return next(new HttpError(401, 'Sessão encerrada. Entre novamente.'));
    delete u.token_version;
    req.user = u;
    next();
  } catch {
    next(new HttpError(401, 'Sessão expirada'));
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden('Seu perfil não tem permissão para esta ação'));

const isAdmin = (u) => u.role === 'master' || u.role === 'gestor';

// IDs dos membros do time de um supervisor (inclui ele mesmo)
function teamIds(user) {
  if (user.role !== 'supervisor') return [user.id];
  return [user.id, ...all('SELECT id FROM users WHERE supervisor_id = ?', user.id).map((r) => r.id)];
}

// Condição SQL de escopo de visibilidade sobre uma coluna user_id
function scopeSql(user, col = 'e.user_id') {
  if (isAdmin(user)) return { sql: '1=1', params: [] };
  if (user.role === 'supervisor') return { sql: `(${col} = ? OR ${col} IN (SELECT id FROM users WHERE supervisor_id = ?))`, params: [user.id, user.id] };
  return { sql: `${col} = ?`, params: [user.id] };
}

function canSeeUser(viewer, userId) {
  if (isAdmin(viewer)) return true;
  return teamIds(viewer).includes(Number(userId));
}

// ---------- Utilitários ----------
const toCents = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};
const fromCents = (c) => (c === null || c === undefined ? null : c / 100);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Política de senha: mínimo 8 caracteres, com letras e números
function checkPassword(pw) {
  const p = String(pw || '');
  if (p.length < 8 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    throw bad('A senha deve ter ao menos 8 caracteres, com letras e números');
  }
  return p;
}

const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (e) { next(e); }
};

module.exports = {
  ROLES, PAYMENT_METHODS, DOC_TYPES, EXPENSE_STATUS, REPORT_STATUS, ADVANCE_STATUS, EXPENSE_FIELDS,
  HttpError, bad, forbidden, notFound,
  signToken, setSessionCookie, clearSessionCookie, authenticate, requireRole, isAdmin, teamIds, scopeSql, canSeeUser,
  toCents, fromCents, brl, isDate, esc, wrap, checkPassword,
};
