// Tiny JSON file store: users, sessions, settings. The app holds no bank
// data at rest; transactions are fetched from Akahu and cached in memory.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'data.json');
  let data = { users: {}, sessions: {}, settings: {} };
  if (existsSync(file)) data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };

  function save() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    get data() { return data; },
    update(fn) {
      fn(data);
      save();
    },
  };
}
