import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { getUser, verifyRequestOrigin } from '@netlify/identity';
import { createHandler } from '../lib/handler.mjs';
import { extractReceipt } from '../lib/receipt.mjs';

const handle = createHandler({
  getUser,
  // Strong consistency so an entry one person adds shows up for the other straight away.
  store: getStore({ name: 'budget', consistency: 'strong' }),
  extractReceipt,
  allowedEmails: (Netlify.env.get('ALLOWED_EMAILS') || '').split(','),
  verifyOrigin: verifyRequestOrigin,
});

export default (req: Request) => handle(req);

export const config: Config = {
  path: '/api/*',
};
