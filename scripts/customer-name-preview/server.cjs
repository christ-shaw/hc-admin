const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { database } = require('../../cloud_functions/manageCustomers/test-support/database.cjs');
const { createRepository } = require('../../cloud_functions/manageCustomers/repository');
const { createSuggestions } = require('../../cloud_functions/manageCustomers/suggestions');
const { createOrderIngestion } = require('../../cloud_functions/manageCustomers/orderIngestion');
const root = path.resolve(__dirname, '../..');
const actor = { id: 'preview' };
const original = { _id: 'order', customerName: '旧订单名称', customerId: 'old', customerAliasId: '', recipientProfileId: '', orderAttribute: 'rental1', customerIngestState: 'done', consignee: '原收件人', consigneePhone: '13900000000', consigneeAddress: '原订单地址 1 号' };
const data = {
  customers: [{ _id: 'one', displayName: '长城数码', status: 'active' }, { _id: 'two', displayName: '长城设备租赁', status: 'active' }, { _id: 'three', displayName: '张先生', status: 'active' }, { _id: 'old', displayName: '原关联客户', status: 'active' }],
  customer_aliases: [{ _id: 'alias', customerId: 'three', name: '长城', salesChannel: '微信', enabled: true }],
  customer_recipient_profiles: [{ _id: 'r1', customerId: 'three', label: '公司', consignee: '张先生', phone: '13800000001', address: '广东省深圳市南山区示例路 100 号 A 座 201 室', enabled: true, useCount: 3 }, { _id: 'r2', customerId: 'three', label: '仓库', consignee: '仓库联系人', phone: '13800000002', address: '广东省深圳市宝安区示例仓库 2 号', enabled: true }],
  orders: [{ ...original }], system_config: [{ _id: 'permission_system', initialized: true }], user_roles: [{ _id: 'ur', userId: 'preview', roleId: 'role' }], roles: [{ _id: 'role', actionPermissions: ['orders:update'] }],
};
const memory = database(data), repo = createRepository(memory.db), suggest = createSuggestions(repo);
const filename = path.join(root, 'cloud_functions/updateOrder/index.js'), actualRequire = createRequire(filename);
const moduleValue = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleValue, exports: moduleValue.exports, console, Date, require(id) {
  if (id === 'wx-server-sdk') return { init() {}, database: () => memory.db };
  if (id === './permissionAuth') return { getCurrentUser: async () => actor };
  return actualRequire(id);
} }, { filename });
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root, cacheDir: '/tmp/hc-customer-preview-vite', optimizeDeps: { entries: ['scripts/customer-name-preview/index.html'] }, plugins: [react(), { name: 'customer-preview', configureServer(server) {
    server.middlewares.use('/__customer-preview', async (request, response) => {
      try {
        let body = ''; for await (const part of request) body += part;
        const { name, payload } = JSON.parse(body);
        let result;
        if (name === 'previewSave') {
          if (!String(payload.customerName || '').trim()) result = { success: false, errMsg: '请填写客户名称' };
          else if (payload.editing) {
            data.orders = [{ ...original }];
            result = await moduleValue.exports.main({ data: { _id: 'order', updateData: { ...payload, customerLinkExpected: { customerId: 'old', customerAliasId: '', recipientProfileId: '' } } } });
          } else {
            const tx = await memory.db.startTransaction();
            try {
              const order = await createOrderIngestion(memory.db).prepareOrder({ ...payload, orderAttribute: 'rental1', customerSelectionMode: payload.customerSelectionMode || 'none' }, actor, tx);
              await tx.collection('orders').add({ data: order }); await tx.commit(); result = { success: true };
            } catch (error) { await tx.rollback(); result = { success: false, errMsg: error.message }; }
          }
        } else if (payload.action === 'search' && payload.scope === 'orderSuggestions') {
          result = payload.keyword === '异常' ? { success: false, errMsg: '测试网络错误' } : await suggest(payload);
        } else if (payload.action === 'get') {
          const customer = data.customers.find(row => row._id === payload.customerId);
          result = { success: !!customer, data: { ...customer, aliases: data.customer_aliases.filter(row => row.customerId === payload.customerId), recipients: data.customer_recipient_profiles.filter(row => row.customerId === payload.customerId), aliasTotal: 1, recipientTotal: 2, pageSize: 20, aliasPage: 1, recipientPage: 1 } };
        } else result = { success: false, errMsg: '此验证页不写入客户主档案' };
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ success: false, errMsg: error.message })); }
    });
  } }], resolve: { alias: [
    { find: /^(?:\.\.\/)+lib\/cloudbase$/, replacement: path.join(__dirname, 'mock.ts') },
    { find: /^(?:\.\.\/)+contexts\/PermissionContext$/, replacement: path.join(__dirname, 'mock.ts') },
  ] }, server: { host: '127.0.0.1', port: 5189, strictPort: true } });
  await server.listen(); console.log('Customer preview: http://127.0.0.1:5189/scripts/customer-name-preview/index.html');
})();
