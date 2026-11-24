// In-memory stand-in for a Netlify Blobs store (same method shapes the API uses).
export function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(key, { type } = {}) {
      if (!data.has(key)) return null;
      const { value } = data.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      const { value, metadata } = data.get(key);
      return { data: value, metadata };
    },
    async set(key, value, { metadata } = {}) { data.set(key, { value, metadata }); },
    async setJSON(key, obj) { data.set(key, { value: JSON.stringify(obj) }); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
