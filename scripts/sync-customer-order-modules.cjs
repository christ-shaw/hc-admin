const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'cloud_functions');
const files = ['orderIngestion.js', 'orderPermission.js', 'repository.js', 'cluster.js', 'matcher.js', 'normalizers.js', 'errors.js', 'identityRevision.js'];
let changed = false;
for (const name of ['saveOrders', 'updateOrder', 'importOrderFromAssist', 'manageAfterSaleOrders']) {
  const directory = path.join(root, name, 'customer');
  if (!process.argv.includes('--check')) fs.mkdirSync(directory, { recursive: true });
  for (const file of [...files, ...(name === 'saveOrders' ? ['orderArchive.js', 'records.js'] : [])]) {
    const source = fs.readFileSync(path.join(root, 'manageCustomers', file), 'utf8');
    const target = path.join(directory, file);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== source) {
      if (process.argv.includes('--check')) { console.error(`客户模块未同步: ${name}/customer/${file}`); changed = true; }
      else fs.writeFileSync(target, source);
    }
  }
}
if (changed) process.exitCode = 1;
