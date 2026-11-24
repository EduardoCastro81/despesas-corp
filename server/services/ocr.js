'use strict';
// Extração automática dos dados de notas/cupons a partir da foto (ou PDF) usando Claude (visão).
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // lê ANTHROPIC_API_KEY (ou perfil do `ant auth login`)
  return client;
}
const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OCR_ENABLED === '1');

const nullable = (type, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'doc_type', 'expense_date', 'total_amount', 'supplier_name', 'supplier_doc',
    'doc_number', 'access_key', 'city', 'payment_method', 'category_suggestion', 'description', 'items', 'confidence', 'warnings'],
  properties: {
    is_receipt: { type: 'boolean', description: 'true se a imagem é um comprovante de despesa legível' },
    doc_type: { type: 'string', enum: ['nfe', 'nfce', 'nfse', 'recibo', 'outro'] },
    expense_date: nullable('string', { description: 'Data de emissão no formato AAAA-MM-DD' }),
    total_amount: nullable('number', { description: 'Valor total pago em reais (ex.: 123.45)' }),
    supplier_name: nullable('string'),
    supplier_doc: nullable('string', { description: 'CNPJ ou CPF do emitente, somente dígitos' }),
    doc_number: nullable('string', { description: 'Número da nota/cupom/recibo' }),
    access_key: nullable('string', { description: 'Chave de acesso de 44 dígitos (NF-e/NFC-e), somente dígitos' }),
    city: nullable('string', { description: 'Cidade/UF do emitente, ex.: São Paulo/SP' }),
    payment_method: nullable('string', { enum: ['dinheiro', 'cartao_corporativo', 'cartao_pessoal', 'pix', 'transferencia', 'faturado'] }),
    category_suggestion: nullable('string', { description: 'Nome exato de uma das categorias informadas' }),
    description: { type: 'string', description: 'Descrição curta da despesa (até 120 caracteres)' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['description', 'amount'],
        properties: { description: { type: 'string' }, amount: nullable('number') },
      },
    },
    confidence: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Problemas percebidos: ilegível, rasurado, sem CNPJ, etc.' },
  },
};

const SYSTEM = `Você lê comprovantes de despesas corporativas brasileiras (NF-e/DANFE, NFC-e/cupom fiscal, NFS-e, recibos e notas de despesa) para preencher uma prestação de contas.
Regras:
- doc_type: "nfe" para DANFE/NF-e; "nfce" para cupom fiscal, SAT ou NFC-e; "nfse" para nota fiscal de serviço; "recibo" para recibo ou nota de despesa sem valor fiscal; "outro" se não for possível classificar.
- total_amount é o valor efetivamente pago (após descontos, incluindo gorjeta/taxa de serviço quando cobrada).
- Datas em AAAA-MM-DD. CNPJ/CPF e chave de acesso apenas com dígitos.
- payment_method: preencha apenas se a forma de pagamento estiver impressa; use "cartao_pessoal" para cartão sem indicação de ser corporativo. Caso contrário, null.
- category_suggestion: escolha exatamente um nome da lista de categorias fornecida, ou null.
- Nunca invente dados: use null quando o campo não estiver legível. Liste em warnings qualquer dúvida.`;

async function extractReceipt(filePath, mime, categories) {
  const data = fs.readFileSync(filePath).toString('base64');
  const media = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data } };

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        media,
        { type: 'text', text: `Categorias disponíveis: ${categories.join('; ')}.\nExtraia os dados deste comprovante.` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('A leitura automática foi recusada para este arquivo. Preencha manualmente.');
  if (response.stop_reason === 'max_tokens') throw new Error('Resposta incompleta da leitura automática. Tente novamente.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

module.exports = { extractReceipt, isConfigured, MODEL };
