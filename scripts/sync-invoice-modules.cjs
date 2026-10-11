const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cloud_functions/saveInvoice/invoiceModel.js'), 'utf8');
for (const name of ['updateInvoice', 'deleteInvoice']) {
  const target = path.join(root, 'cloud_functions', name, 'invoiceModel.js');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== source) throw new Error(`${name} 发票模块未同步`);
  } else fs.writeFileSync(target, source);
}
