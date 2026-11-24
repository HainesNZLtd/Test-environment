// Create or reset a login. Usage: npm run add-user -- <username>
// The password is read from the terminal without echoing, or from the
// NEW_PASSWORD environment variable for scripted setups.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { hashPassword } from '../lib/auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const username = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
  console.error('Usage: npm run add-user -- <username>   (letters, numbers, . _ -)');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

let password = process.env.NEW_PASSWORD;
if (!password) {
  password = await promptHidden(`Password for ${username}: `);
  const again = await promptHidden('Again: ');
  if (password !== again) {
    console.error('Passwords did not match.');
    process.exit(1);
  }
}
if (password.length < 12) {
  console.error('Use at least 12 characters. A few random words works well.');
  process.exit(1);
}

const store = createStore(process.env.DATA_DIR || join(ROOT, 'data'));
store.update((d) => {
  d.users[username] = hashPassword(password);
  // Resetting a password signs that user out everywhere.
  for (const [k, s] of Object.entries(d.sessions)) if (s.username === username) delete d.sessions[k];
});
console.log(`Saved login for ${username}.`);
