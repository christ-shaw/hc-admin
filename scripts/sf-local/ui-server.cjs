// Uses the real workbench with an isolated, in-memory SF backend.
const path = require('node:path');
const { createRuntime } = require('./runtime.cjs');
const root = path.resolve(__dirname, '../..');
const port = Number(process.env.SF_UI_PORT || 5192);
const origin = `http://127.0.0.1:${port}`;
let runtime;

async function reset() {
  runtime = createRuntime();
  const base = runtime.snapshot().orders[0];
  for (let i = 1; i <= 6; i++) {
    const id = `demo-order-${i}`;
    runtime.put('orders', { ...base, _id: id, serialNumber: i, onlineOrderNumber: `LOCAL-${String(i).padStart(3, '0')}`,
      consignee: ['测试张先生', '测试李女士', '测试王先生'][(i - 1) % 3],
      consigneePhone: `1390000000${i}`, consigneeAddress: `广东省深圳市南山区本地测试路 ${i} 号（虚构地址）`,
      shippingFee: i % 2 ? 'cod' : 'prepaid', needsOutbound: true,
      products: [{ productName: i % 2 ? 'iPhone 16' : '华为 Mate 70', quantity: i % 2 + 1 }],
      customerRemark: `本地测试订单 ${i}`, outboundRecordId: `demo-out-${i}`,
    });
    runtime.put('outbound_records', { _id: `demo-out-${i}`, orderIds: [id], outboundStatus: 'pending', trackingNumber: '', shippingMethod: i % 2 ? 'cod' : 'prepaid' });
  }
  const applied = await runtime.invoke('applySfExpress', { sourceOrderId: 'demo-order-3' });
  if (!applied.success) throw new Error(applied.errMsg);
  const record = (await runtime.db.collection('sf_express_orders').doc(applied.sfExpressOrderId).get()).data;
  runtime.put('sf_express_orders', { ...record, printCount: 1, lastPrintTime: new Date().toISOString() });
}

function testPdf(waybillNo) {
  const text = `LOCAL TEST - NOT A SHIPPING LABEL / ${String(waybillNo).replace(/[^A-Za-z0-9-]/g, '')}`;
  const stream = `BT /F1 12 Tf 30 250 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString('base64');
}

(async () => {
  await reset();
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root, cacheDir: path.join(root, 'tmp/sf-ui-vite'),
    optimizeDeps: { entries: ['scripts/sf-local/ui.html'] },
    plugins: [react(), { name: 'sf-local-ui', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
          res.statusCode = 403; res.end('Local requests only'); return;
        }
        if (req.url === '/' || req.url?.split('?')[0] === '/sf-express') req.url = '/scripts/sf-local/ui.html';
        if (req.url !== '/__sf-local') return next();
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return; }
        try {
          let body = ''; for await (const part of req) { body += part; if (body.length > 65536) throw new Error('请求过大'); }
          const { name, data } = JSON.parse(body); let result;
          if (name === 'reset') { await reset(); result = { success: true }; }
          else if (name === 'printSfWaybill') {
            const record = (await runtime.db.collection('sf_express_orders').doc(data.sfExpressOrderId).get()).data;
            if (record.status !== 'applied' || !record.waybillNo) throw new Error('请先生成运单');
            const printedAt = new Date().toISOString();
            runtime.put('sf_express_orders', { ...record, printCount: Number(record.printCount || 0) + 1, lastPrintTime: printedAt });
            result = { success: true, sfExpressOrderId: record._id, waybillNo: record.waybillNo, printedAt,
              mimeType: 'application/pdf', fileName: `LOCAL-TEST-${record.waybillNo}.pdf`, pdfBase64: testPdf(record.waybillNo) };
          } else result = await runtime.invoke(name, data);
          res.end(JSON.stringify(result));
        } catch (error) { res.end(JSON.stringify({ success: false, errMsg: error.message })); }
      });
    } }],
    resolve: { alias: [
      { find: /^(?:\.\.\/)+lib\/cloudbase$/, replacement: path.join(__dirname, 'ui-mocks.ts') },
      { find: /^(?:\.\.\/)+contexts\/(?:PermissionContext|DictionaryContext|TabWorkspaceContext)$/, replacement: path.join(__dirname, 'ui-mocks.ts') },
    ] }, server: { host: '127.0.0.1', port, strictPort: true } });
  await server.listen(); console.log(`顺丰订单本地调试：${origin}/sf-express`);
})().catch(error => { console.error(error); process.exitCode = 1; });
