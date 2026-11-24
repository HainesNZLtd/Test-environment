// Reads a receipt photo with Claude and returns the fields needed for an entry.
// The person always confirms the result before it is saved.
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from './budget.mjs';

const nullable = (type, description) => ({ anyOf: [{ type }, { type: 'null' }], description });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'merchant', 'date', 'total', 'category', 'summary'],
  properties: {
    is_receipt: { type: 'boolean', description: 'False if the image is not a purchase receipt or is unreadable' },
    merchant: nullable('string', 'Store or business name as a person would say it, e.g. "Woolworths", not the legal entity'),
    date: nullable('string', 'Purchase date as YYYY-MM-DD'),
    total: nullable('number', 'Final amount paid in NZD, including GST, after discounts. Negative for a refund receipt.'),
    category: { type: 'string', enum: CATEGORIES },
    summary: { type: 'string', description: 'Up to 8 words on what was bought, e.g. "Weekly shop, nappies, wine"' },
  },
};

const SYSTEM = `You read photos of New Zealand shop receipts for a household budget app.
Return the final total actually paid (the EFTPOS/card/cash amount), including GST and after any discounts or loyalty savings. Ignore subtotals, GST lines, change given and loyalty point balances.
NZ receipts write dates day first (24/11/26 is 24 November 2026). If the year is missing, use the year that makes the date closest to, but not after, today.
Category is Groceries for supermarkets, butchers, greengrocers, bakeries and food stores. Everything else is Misc.
If something is unreadable, return null for that field rather than guessing.`;

export async function extractReceipt({ bytes, mediaType, today }) {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') } },
        { type: 'text', text: `Today is ${today}. Read this receipt.` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Receipt could not be read');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Receipt could not be read');
  return tidy(JSON.parse(text), today);
}

/** Guard against model output that would make a bad entry. */
export function tidy(raw, today) {
  const out = {
    isReceipt: Boolean(raw.is_receipt),
    merchant: typeof raw.merchant === 'string' ? raw.merchant.trim().slice(0, 80) : '',
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && raw.date <= today ? raw.date : today,
    total: Number.isFinite(raw.total) && raw.total !== 0 && Math.abs(raw.total) < 100_000 ? Math.round(raw.total * 100) / 100 : null,
    category: CATEGORIES.includes(raw.category) ? raw.category : 'Misc',
    note: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 200) : '',
  };
  return out;
}
