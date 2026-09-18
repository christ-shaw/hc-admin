const { fail } = require('./errors');
const { clean } = require('./normalizers');
async function resolveCustomer(customerId, getCustomer) {
  const visited = new Set();
  let id = clean(customerId);
  while (id) {
    if (visited.has(id)) fail('CUSTOMER_MERGE_CYCLE', '客户合并链存在循环，请修复客户资料');
    if (visited.size >= 100) fail('CUSTOMER_MERGE_DEPTH', '客户合并链过长');
    visited.add(id);
    const customer = await getCustomer(id);
    if (!customer) fail('CUSTOMER_NOT_FOUND', '客户或合并目标不存在');
    if (customer.status === 'merged') {
      id = clean(customer.mergedIntoCustomerId);
      if (!id) fail('CUSTOMER_MERGE_TARGET_INVALID', '客户合并目标无效');
      continue;
    }
    if (customer.mergedIntoCustomerId) fail('CUSTOMER_MERGE_TARGET_INVALID', '客户状态与合并映射不一致');
    if (customer.status !== 'active') fail('CUSTOMER_UNAVAILABLE', '客户已停用，不能接收新订单');
    return { customer, path: [...visited] };
  }
  fail('CUSTOMER_REQUIRED', '请选择客户');
}
async function validateCustomerReferences(repository, refs, store = repository.db) {
  const get = (collection, id) => repository.getDocById(collection, id, store);
  const resolve = id => resolveCustomer(id, key => get('customers', key));
  const target = await resolve(refs.customerId);
  const result = { customerId: target.customer._id };
  for (const [field, collection] of [['customerAliasId', 'customer_aliases'], ['recipientProfileId', 'customer_recipient_profiles']]) {
    const id = clean(refs[field]);
    if (!id) continue;
    const row = await get(collection, id);
    if (!row || row.enabled === false) fail('CUSTOMER_REFERENCE_UNAVAILABLE', '所选别名或收货档案不存在或已停用');
    const owner = await resolve(row.customerId);
    if (owner.customer._id !== target.customer._id) fail('CUSTOMER_REFERENCE_MISMATCH', '所选别名或收货档案不属于该客户');
    result[field] = id;
  }
  return result;
}
module.exports = { resolveCustomer, validateCustomerReferences };
