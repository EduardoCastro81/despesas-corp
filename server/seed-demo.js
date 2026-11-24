'use strict';
// Popula o banco com dados de demonstração: equipe, despesas com comprovantes, prestações em vários estágios.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { one, all, run, tx, UPLOAD_DIR } = require('./db');

if (one(`SELECT COUNT(*) n FROM users WHERE email LIKE '%@demo.com'`).n) {
  console.log('Dados de demonstração já existem.');
  process.exit(0);
}

const pass = bcrypt.hashSync('demo123', 10);
const mkUser = (name, email, role, sup, cc) => Number(run(
  'INSERT INTO users(name,email,password_hash,role,supervisor_id,cost_center,department) VALUES(?,?,?,?,?,?,?)',
  name, email, pass, role, sup, cc, cc === 'CC-100' ? 'Comercial' : 'Operações').lastInsertRowid);

const cat = Object.fromEntries(all('SELECT id, name FROM categories').map((c) => [c.name, c.id]));
const master = one(`SELECT id FROM users WHERE role = 'master'`).id;

function receiptSvg({ supplier, cnpj, date, amount, doc, items }) {
  const lines = items.map((it, i) => `<text x="20" y="${170 + i * 22}">${it[0]}</text><text x="340" y="${170 + i * 22}" text-anchor="end">${it[1].toFixed(2).replace('.', ',')}</text>`).join('');
  const h = 260 + items.length * 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="${h}" font-family="monospace" font-size="14">
<rect width="100%" height="100%" fill="#fffef8"/><g fill="#222">
<text x="180" y="34" text-anchor="middle" font-weight="bold" font-size="16">${supplier}</text>
<text x="180" y="56" text-anchor="middle">CNPJ ${cnpj}</text>
<text x="180" y="88" text-anchor="middle">DOCUMENTO AUXILIAR DA NFC-e</text>
<text x="20" y="120">Nº ${doc}   Emissão ${date.split('-').reverse().join('/')}</text>
<line x1="20" y1="140" x2="340" y2="140" stroke="#999" stroke-dasharray="4"/>${lines}
<line x1="20" y1="${h - 90}" x2="340" y2="${h - 90}" stroke="#999" stroke-dasharray="4"/>
<text x="20" y="${h - 62}" font-weight="bold">VALOR TOTAL R$</text><text x="340" y="${h - 62}" text-anchor="end" font-weight="bold">${amount.toFixed(2).replace('.', ',')}</text>
<text x="180" y="${h - 26}" text-anchor="middle" font-size="11">Consulte pela chave de acesso</text></g></svg>`;
}

const suppliers = {
  'Alimentação': [['Restaurante Sabor Mineiro', '12345678000190'], ['Padaria Pão Dourado', '23456789000101'], ['Churrascaria Boi na Brasa', '34567890000112']],
  'Hospedagem': [['Hotel Central Plaza', '45678901000123'], ['Pousada Bela Vista', '56789012000134']],
  'Transporte (táxi/app)': [['Uber do Brasil Tecnologia', '17895646000187'], ['Rádio Táxi Cidade', '67890123000145']],
  'Combustível': [['Posto Estrela LTDA', '78901234000156'], ['Auto Posto Rodovia', '89012345000167']],
  'Estacionamento': [['Estapar Estacionamentos', '61079117000105']],
  'Pedágio': [['Concessionária Rota Sul', '90123456000178']],
  'Material de escritório': [['Papelaria Kalunga', '43283811000150']],
  'Representação/clientes': [['Restaurante Fasano', '01234567000189']],
};
const ranges = { 'Alimentação': [25, 180], 'Hospedagem': [220, 720], 'Transporte (táxi/app)': [18, 160], 'Combustível': [120, 420], 'Estacionamento': [15, 60], 'Pedágio': [8, 35], 'Material de escritório': [30, 260], 'Representação/clientes': [180, 650] };
const cities = ['São Paulo/SP', 'Campinas/SP', 'Curitiba/PR', 'Belo Horizonte/MG', 'Rio de Janeiro/RJ'];
const pays = ['cartao_corporativo', 'cartao_corporativo', 'cartao_pessoal', 'pix', 'dinheiro', 'adiantamento'];
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

tx(() => {
  const gestor = mkUser('Gabriela Gestora', 'gestor@demo.com', 'gestor', null, 'CC-ADM');
  const supCom = mkUser('Sérgio Supervisor', 'supervisor@demo.com', 'supervisor', gestor, 'CC-100');
  const supOps = mkUser('Paula Supervisora', 'supervisora@demo.com', 'supervisor', gestor, 'CC-200');
  const team = [
    mkUser('Carlos Colaborador', 'carlos@demo.com', 'colaborador', supCom, 'CC-100'),
    mkUser('Ana Vendedora', 'ana@demo.com', 'colaborador', supCom, 'CC-100'),
    mkUser('Bruno Técnico', 'bruno@demo.com', 'colaborador', supOps, 'CC-200'),
    mkUser('Diana Técnica', 'diana@demo.com', 'colaborador', supOps, 'CC-200'),
  ];

  const mkExpense = (userId, dAgo, catName, reportId = null, status = 'rascunho', advanceId = null) => {
    const [sup, cnpj] = pick(suppliers[catName]);
    const [lo, hi] = ranges[catName];
    const amount = Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
    const date = daysAgo(dAgo);
    const doc = String(10000 + Math.floor(rnd() * 89999));
    const pm = advanceId ? 'adiantamento' : pick(pays.filter((p) => p !== 'adiantamento'));
    const cc = one('SELECT cost_center FROM users WHERE id = ?', userId).cost_center;
    const id = Number(run(`INSERT INTO expenses(user_id, report_id, category_id, expense_date, amount_cents, payment_method, doc_type, doc_number,
      supplier_name, supplier_doc, description, city, cost_center, status, created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, reportId, cat[catName], date, Math.round(amount * 100), pm, catName === 'Hospedagem' ? 'nfse' : 'nfce', doc, sup, cnpj,
    `${catName} — ${pick(['visita a cliente', 'viagem técnica', 'reunião comercial', 'atendimento em campo'])}`, pick(cities), cc, status, userId).lastInsertRowid);
    if (rnd() > 0.12) {
      const name = `${crypto.randomUUID()}.svg`;
      const parts = [[`${catName.split(' ')[0].toUpperCase()} ITEM 1`, amount * 0.6], ['ITEM 2', amount * 0.4]];
      fs.writeFileSync(path.join(UPLOAD_DIR, name), receiptSvg({ supplier: sup.toUpperCase(), cnpj: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'), date, amount, doc, items: parts }));
      run('INSERT INTO attachments(expense_id, stored_name, original_name, mime, size, uploaded_by) VALUES(?,?,?,?,?,?)', id, name, `cupom-${doc}.svg`, 'image/svg+xml', 1000, userId);
    }
    return id;
  };
  const cats = Object.keys(suppliers);
  const mkReport = (userId, title, status, dStart, n, { advance = null, hist = [] } = {}) => {
    const rid = Number(run(`INSERT INTO reports(user_id, title, period_start, period_end, advance_id, status, submitted_at, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, userId, title, daysAgo(dStart), daysAgo(Math.max(0, dStart - 10)), advance, status,
    status === 'rascunho' ? null : daysAgo(Math.max(0, dStart - 11)) + ' 09:00:00', daysAgo(dStart) + ' 08:00:00', daysAgo(Math.max(0, dStart - 12)) + ' 10:00:00').lastInsertRowid);
    const expStatus = { rascunho: 'rascunho', aguardando_supervisor: 'em_analise', aguardando_gestor: 'em_analise', aprovada: 'aprovada', finalizada: 'aprovada', devolvida: 'rascunho' }[status];
    for (let i = 0; i < n; i++) mkExpense(userId, dStart - Math.floor(rnd() * 10), pick(cats), rid, expStatus, advance);
    run('INSERT INTO report_history(report_id, user_id, action, to_status, created_at) VALUES(?,?,?,?,?)', rid, userId, 'criacao', 'rascunho', daysAgo(dStart) + ' 08:00:00');
    for (const [uid, action, to, comment, dd] of hist) run('INSERT INTO report_history(report_id, user_id, action, to_status, comment, created_at) VALUES(?,?,?,?,?,?)', rid, uid, action, to, comment, daysAgo(dd) + ' 15:00:00');
    return rid;
  };

  // Adiantamentos
  const adv1 = Number(run(`INSERT INTO advances(user_id, amount_cents, purpose, status, approved_by, approved_at, paid_at, created_by) VALUES(?,?,?,?,?,datetime('now','-50 days'),datetime('now','-49 days'),?)`,
    team[0], 150000, 'Viagem comercial Curitiba', 'liquidado', gestor, gestor).lastInsertRowid);
  const adv2 = Number(run(`INSERT INTO advances(user_id, amount_cents, purpose, status, approved_by, approved_at, paid_at, created_by) VALUES(?,?,?,?,?,datetime('now','-15 days'),datetime('now','-14 days'),?)`,
    team[2], 200000, 'Instalação em cliente — Belo Horizonte', 'pago', gestor, gestor).lastInsertRowid);
  run(`INSERT INTO advances(user_id, amount_cents, purpose, status, created_by) VALUES(?,?,?,?,?)`, team[1], 80000, 'Feira do setor — Rio de Janeiro', 'solicitado', team[1]);

  // Prestações em diferentes etapas
  const r1 = mkReport(team[0], 'Viagem Curitiba — cliente Alfa', 'finalizada', 55, 7, { advance: adv1, hist: [[team[0], 'envio', 'aguardando_supervisor', null, 43], [supCom, 'aprovacao_supervisor', 'aguardando_gestor', 'Conferido', 42], [gestor, 'aprovacao_gestor', 'aprovada', null, 41], [gestor, 'finalizacao', 'finalizada', 'Reembolso via PIX', 39]] });
  run(`UPDATE reports SET supervisor_approved_by=?, supervisor_approved_at=?, approved_by=?, approved_at=?, finalized_by=?, finalized_at=? WHERE id=?`, supCom, daysAgo(42), gestor, daysAgo(41), gestor, daysAgo(39), r1);
  const r2 = mkReport(team[1], 'Visitas a clientes — região Campinas', 'aprovada', 35, 6, { hist: [[team[1], 'envio', 'aguardando_supervisor', null, 24], [supCom, 'aprovacao_supervisor', 'aguardando_gestor', null, 23], [gestor, 'aprovacao_gestor', 'aprovada', 'Ok', 22]] });
  run(`UPDATE reports SET supervisor_approved_by=?, supervisor_approved_at=?, approved_by=?, approved_at=? WHERE id=?`, supCom, daysAgo(23), gestor, daysAgo(22), r2);
  const r3 = mkReport(team[2], 'Instalação BH — semana 1', 'aguardando_gestor', 14, 8, { advance: adv2, hist: [[team[2], 'envio', 'aguardando_supervisor', null, 3], [supOps, 'aprovacao_supervisor', 'aguardando_gestor', 'Conferido, ok', 2]] });
  run(`UPDATE reports SET supervisor_approved_by=?, supervisor_approved_at=? WHERE id=?`, supOps, daysAgo(2), r3);
  mkReport(team[0], 'Despesas de campo — mês atual', 'aguardando_supervisor', 12, 5, { hist: [[team[0], 'envio', 'aguardando_supervisor', 'Segue prestação do mês', 1]] });
  mkReport(team[3], 'Atendimento emergencial Sorocaba', 'devolvida', 20, 4, { hist: [[team[3], 'envio', 'aguardando_supervisor', null, 8], [supOps, 'devolucao', 'devolvida', 'Anexar o comprovante do hotel', 7]] });
  run(`UPDATE reports SET last_comment = 'Anexar o comprovante do hotel' WHERE status = 'devolvida'`);
  mkReport(team[1], 'Feira do setor', 'rascunho', 6, 3);
  // Despesas soltas (sem prestação)
  for (const u of team) for (let i = 0; i < 3; i++) mkExpense(u, Math.floor(rnd() * 25), pick(cats));
  // Despesas de meses anteriores para histórico
  for (let m = 2; m <= 5; m++) {
    for (const u of team) {
      const rid = mkReport(u, `Prestação ${m} meses atrás`, 'finalizada', m * 30 + 5, 3 + Math.floor(rnd() * 4), { hist: [[gestor, 'finalizacao', 'finalizada', null, m * 30 - 10]] });
      run(`UPDATE reports SET approved_by=?, approved_at=?, finalized_by=?, finalized_at=?, supervisor_approved_at=? WHERE id=?`, gestor, daysAgo(m * 30 - 8), gestor, daysAgo(m * 30 - 10), daysAgo(m * 30 - 6), rid);
    }
  }
  // Uma glosa e uma edição de supervisor para auditoria
  const g = one('SELECT id, amount_cents FROM expenses WHERE report_id = ? ORDER BY amount_cents DESC LIMIT 1', r3);
  run(`UPDATE expenses SET status='glosada', glosa_reason='Valor acima da política sem justificativa' WHERE id = ?`, g.id);
  run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, reason) VALUES(?,?,?,?,?,?)`, g.id, supOps, 'supervisor', 'glosa',
    JSON.stringify([{ field: 'status', label: 'Situação', before: 'Em análise', after: 'Glosada' }]), 'Valor acima da política sem justificativa');
  const ed = one('SELECT id FROM expenses WHERE report_id = ? AND id <> ? LIMIT 1', r3, g.id);
  run(`INSERT INTO expense_edits(expense_id, editor_id, editor_role, action, changes, reason) VALUES(?,?,?,?,?,?)`, ed.id, supOps, 'supervisor', 'edicao',
    JSON.stringify([{ field: 'category_id', label: 'Categoria', before: 'Alimentação', after: 'Representação/clientes' }]), 'Almoço com cliente, categoria correta é representação');
  run(`INSERT INTO notifications(user_id, type, title, body, link, data) VALUES(?,?,?,?,?,?)`, gestor, 'edicao_despesa',
    `Supervisor Paula Supervisora editou a despesa #${ed.id} de Bruno Técnico`, 'Categoria: Alimentação → Representação/clientes\nJustificativa: Almoço com cliente, categoria correta é representação', `#/despesa/${ed.id}`,
    JSON.stringify({ expense_id: ed.id, changes: [{ field: 'category_id', label: 'Categoria', before: 'Alimentação', after: 'Representação/clientes' }], reason: 'Almoço com cliente, categoria correta é representação' }));
  run(`INSERT INTO notifications(user_id, type, title, body, link) VALUES(?,?,?,?,?)`, gestor, 'aprovacao_pendente', `Prestação #${r3} de Bruno Técnico aprovada pelo supervisor — aguardando gestor`, 'Instalação BH — semana 1', `#/prestacao/${r3}`);
  void master;
});

console.log(`Dados de demonstração criados. Senha de todos os usuários demo: demo123
  gestor@demo.com (Gestor) · supervisor@demo.com / supervisora@demo.com (Supervisores)
  carlos@demo.com, ana@demo.com, bruno@demo.com, diana@demo.com (Colaboradores)`);
