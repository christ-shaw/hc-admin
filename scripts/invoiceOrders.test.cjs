const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function load(file) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: id => id === './orderProducts' ? load('src/utils/orderProducts.ts') : require(id) });
  return module.exports;
}
const { orderSnapshot, replaceLinkedOrders, validateLinkedInvoice } = load('src/utils/invoiceOrders.ts');
test('关联金额按分累计、未调整自动跟随、调整后增减订单保持输入', () => {
  const a = orderSnapshot({ _id: 'a', products: [{ amount: 0.1 }], attachments: [] });
  const b = orderSnapshot({ _id: 'b', products: [{ amount: 0.2 }], attachments: [] });
  let form = replaceLinkedOrders({ entryMode: 'linkedOrders', invoiceAmount: 0 }, [a, b], false);
  assert.equal(form.invoiceAmount, 0.3);
  form = replaceLinkedOrders({ ...form, invoiceAmount: 0.25, amountAdjustmentReason: '折扣' }, [a], true);
  assert.equal(form.invoiceAmount, 0.25); assert.equal(form.linkedOrderTotal, 0.1);
  assert.equal(validateLinkedInvoice(form), null);
  assert.match(validateLinkedInvoice({ ...form, amountAdjustmentReason: '' }), /原因/);
  assert.match(validateLinkedInvoice({ ...form, invoiceAmount: 0.001 }), /两位小数/);
  assert.match(validateLinkedInvoice({ ...form, linkedOrders: [] }), /关联/);
  assert.equal(validateLinkedInvoice({ entryMode: 'manual' }), null);
});
test('历史扁平订单附件和金额可读取', () => {
  const snapshot = orderSnapshot({ _id: 'old', amount: 300, productName: '手机', quantity: 2, attachments: [{ fileID: 'f', fileName: '凭证' }] });
  assert.equal(snapshot.amount, 300); assert.equal(snapshot.attachments[0].fileID, 'f');
});
