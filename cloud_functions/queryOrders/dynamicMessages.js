const DISPLAY_LIMIT = 20;
const FIELDS = {
  _id: true, customerName: true, onlineOrderNumber: true, salesperson: true,
  date: true, createTime: true, serialNumber: true, returnStatus: true,
  products: true, amount: true, brand: true, productName: true, quantity: true,
  paymentAccount: true, paymentSplits: true,
};

function hasUnpaidSplit(value, parseStrings) {
  if (typeof value === 'string') {
    if (!parseStrings) return false;
    try { value = JSON.parse(value); } catch (_) { return false; }
  }
  return Array.isArray(value) && value.some(split => split && split.account === '未收款');
}

function hasUnpaid(order, parseStrings) {
  return order.paymentAccount === '未收款' || hasUnpaidSplit(order.paymentSplits, parseStrings)
    || (Array.isArray(order.products) && order.products.some(product =>
      product.paymentAccount === '未收款' || hasUnpaidSplit(product.paymentSplits, parseStrings)));
}

function newest(orders) {
  return orders.sort((a, b) => {
    const time = order => new Date(order.date || (order.createTime && order.createTime.$date) || 0).getTime() || 0;
    return time(b) - time(a) || (Number(b.serialNumber) || 0) - (Number(a.serialNumber) || 0);
  }).slice(0, DISPLAY_LIMIT);
}

async function queryDynamicMessages(db) {
  const _ = db.command;
  const unreturnedCondition = {
    orderType: _.in(['postRentalShip', 'postRentalReturn']),
    returnStatus: _.neq('returned'),
  };
  const unpaidCondition = _.or([
    { paymentAccount: '未收款' }, { 'paymentSplits.account': '未收款' },
    { 'products.paymentAccount': '未收款' }, { 'products.paymentSplits.account': '未收款' },
  ]);
  async function category(condition) {
    const query = () => db.collection('orders').where(condition);
    const [count, page] = await Promise.all([
      query().count(),
      query().field(FIELDS).orderBy('date', 'desc').orderBy('serialNumber', 'desc').limit(DISPLAY_LIMIT).get(),
    ]);
    return { total: count.total, orders: page.data || [] };
  }

  // 极旧拆分收款以 JSON 字符串保存：只读取这些兼容候选，不扫描全部订单。
  // 解析后再判定，避免把备注中的“未收款”误计入，且不重复计算结构化字段已命中的订单。
  async function legacyPayments() {
    const jsonArray = db.RegExp({ regexp: '^\\s*\\[', options: '' });
    const condition = _.or([{ paymentSplits: jsonArray }, { 'products.paymentSplits': jsonArray }]);
    let total = 0, orders = [];
    for (let skip = 0; ; skip += 100) {
      const page = await db.collection('orders').where(condition).field(FIELDS)
        .orderBy('_id', 'asc').skip(skip).limit(100).get();
      const rows = page.data || [];
      const matches = rows.filter(order => !hasUnpaid(order, false) && hasUnpaid(order, true));
      total += matches.length;
      orders = newest([...orders, ...matches]);
      if (rows.length < 100) return { total, orders };
    }
  }

  const [unreturned, unreceived, legacy] = await Promise.all([
    category(unreturnedCondition), category(unpaidCondition), legacyPayments(),
  ]);
  return { success: true, data: { unreturned, unreceived: {
    total: unreceived.total + legacy.total,
    orders: newest([...unreceived.orders, ...legacy.orders]),
  } } };
}

module.exports = { queryDynamicMessages };
