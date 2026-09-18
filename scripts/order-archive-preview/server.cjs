// Isolated UI verification: real cloud-function entry points, in-memory data only.
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { database } = require('../../cloud_functions/manageCustomers/test-support/database.cjs');
const root = path.resolve(__dirname, '../..');
const data = { customers: [{ _id: 'existing', displayName: '示例老客户', status: 'active' }],
  customer_aliases: [], customer_recipient_profiles: [], orders: [],
  system_config: [{ _id: 'permission_system', initialized: true }],
  roles: [{ _id: 'role', actionPermissions: ['orders:create', 'customers:write'] }],
  user_roles: [{ _id: 'user', userId: 'preview', roleId: 'role' }] };
const memory = database(data);
function entry(name) {
  const filename = path.join(root, 'cloud_functions', name, 'index.js');
  const realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console,
    require(id) {
      if (id === 'wx-server-sdk') return { init() {}, database: () => memory.db };
      if (id === './permissionAuth') return { getCurrentUser: async () => ({ id: 'preview' }) };
      return realRequire(id);
    } }, { filename });
  return module.exports.main;
}
const handlers = { manageCustomers: entry('manageCustomers'), saveOrders: entry('saveOrders') };
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root, cacheDir: '/tmp/hc-order-archive-vite',
    optimizeDeps: { entries: ['scripts/order-archive-preview/index.html'] },
    plugins: [react(), { name: 'archive-preview', configureServer(server) {
      server.middlewares.use('/__archive-preview', async (request, response) => {
        try {
          let body = ''; for await (const part of request) body += part;
          const { name, payload } = JSON.parse(body);
          const result = name === 'inspect' ? data : await handlers[name](payload);
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
        } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ success: false, errMsg: error.message })); }
      });
    } }], resolve: { alias: [
      { find: /^(?:\.\.\/)+lib\/cloudbase$/, replacement: path.join(__dirname, 'mock.ts') },
      { find: /^(?:\.\.\/)+contexts\/PermissionContext$/, replacement: path.join(__dirname, 'mock.ts') },
    ] }, server: { host: '127.0.0.1', port: 5191, strictPort: true } });
  await server.listen(); console.log('http://127.0.0.1:5191/scripts/order-archive-preview/index.html');
})();
