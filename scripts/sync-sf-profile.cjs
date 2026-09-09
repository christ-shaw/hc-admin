const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'cloud_functions');
const source = fs.readFileSync(path.join(root, 'sfProfile.cjs'));
const names = ['getSfAccessToken', 'applySfExpress', 'cancelSfExpress', 'querySfOrderResult', 'printSfWaybill', 'manageSfPluginPrint', 'querySfExpressOrders', 'manageSfShipment', 'manageSfConfig'];
for (const name of names) {
  const target = path.join(root, name, 'sfProfile.js');
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || !source.equals(fs.readFileSync(target))) throw new Error(`${name}: sfProfile.js is out of sync`);
  } else fs.writeFileSync(target, source);
}
console.log('SF profile modules synchronized.');
