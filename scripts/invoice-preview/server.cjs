const path = require('node:path');
(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: __dirname, plugins: [{ name: 'mock-cloud', enforce: 'pre', resolveId(id) { if (id.endsWith('/contexts/DictionaryContext')) return path.join(__dirname, 'mock-dicts.ts'); if (id.endsWith('/lib/cloudbase')) return path.join(__dirname, 'mock.ts'); } }], server: { host: '127.0.0.1', port: 5188, fs: { allow: [path.resolve(__dirname, '../..')] } }, css: { postcss: path.resolve(__dirname, '../..') } });
  await server.listen(); server.printUrls();
})();
