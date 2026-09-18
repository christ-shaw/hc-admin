const { createHash } = require('node:crypto');
const { createRepository } = require('./repository');
const { validateCustomerReferences } = require('./cluster');
const { matchIdentity } = require('./matcher');
const { clean, normalizeName, normalizeIdentity } = require('./normalizers');
const { CustomerError, fail } = require('./errors');
const { readIdentityRevision, bumpIdentityRevision } = require('./identityRevision');

const REF_FIELDS = ['customerId', 'customerAliasId', 'recipientProfileId'];
const SOURCE_FIELDS = ['renewalSourceOrderId', 'renewalSourceSerialNumber', 'rental2TransferSourceOrderId',
  'rental2TransferSourceSerialNumber', 'rental2TransferMode', 'afterSaleSourceOrderId', 'afterSaleSourceSerialNumber'];
const LINK_FIELDS = [...REF_FIELDS, 'customerLinkStatus', 'customerLinkedAt', 'customerLinkedBy',
  'customerLinkIgnoreReason', 'customerLinkMethod', 'customerIngestState', 'customerIngestActor',
  'customerIngestVersion', 'customerSelectionMode', 'createCustomerArchive', 'customerArchiveRequested'];
const rental = value => ['rental1', 'rental2', '租赁1', '租赁2'].includes(value);
function stripLinkFields(input, editing = false) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !LINK_FIELDS.includes(key.split('.')[0])
    && !(editing && SOURCE_FIELDS.includes(key.split('.')[0])) && key !== '_id'));
}
function pending(actor, state = 'pending') {
  return { customerId: '', customerAliasId: '', recipientProfileId: '', customerLinkStatus: 'pending',
    customerLinkedAt: '', customerLinkedBy: '', customerLinkMethod: '', customerIngestVersion: 1,
    customerIngestActor: actor.id, customerIngestState: state };
}
function linked(refs, actor, method) {
  return { customerId: refs.customerId, customerAliasId: refs.customerAliasId || '', recipientProfileId: refs.recipientProfileId || '',
    customerLinkStatus: 'linked', customerLinkedAt: new Date().toISOString(), customerLinkedBy: actor.id,
    customerLinkMethod: method, customerIngestState: 'done' };
}
function sourceRef(order) {
  const sources = [['renewalSourceOrderId', 'renewal'], ['rental2TransferSourceOrderId', 'transfer'], ['afterSaleSourceOrderId', 'afterSale']]
    .filter(([field]) => clean(order[field]));
  if (sources.length > 1) fail('CUSTOMER_SOURCE_CONFLICT', '订单来源关系冲突');
  return sources.length ? { id: clean(order[sources[0][0]]), kind: sources[0][1] } : null;
}
function verifySource(order, source, kind) {
  if (!source || !rental(source.orderAttribute) || source.afterSaleSourceOrderId) return false;
  if (!normalizeName(source.customerName) || normalizeName(source.customerName) !== normalizeName(order.customerName)) return false;
  // An order number identifies a platform order only together with its channel and source ID.
  if (clean(source.onlineOrderNumber) !== clean(order.onlineOrderNumber) || clean(source.salesChannel) !== clean(order.salesChannel)) return false;
  if (kind === 'afterSale') return ['rental2', '租赁2'].includes(source.orderAttribute)
    && ['shipped', '已发货'].includes(source.status) && order.orderSource === 'service' && order.orderType === 'postRentalShip';
  if (!['newBusiness', '新增业务'].includes(source.orderType) || order.orderType !== 'newBusiness') return false;
  const products = Array.isArray(order.products) ? order.products : [];
  if (kind === 'renewal') return order.orderAttribute === source.orderAttribute && products.length === 1
    && products[0].brand === '虚拟产品' && products[0].productName === '续期租金';
  const physical = (Array.isArray(source.products) && source.products.length ? source.products : [source])
    .some(item => item.brand && item.brand !== '虚拟产品');
  return physical && !source.rental2TransferSourceOrderId && ['rental1', '租赁1'].includes(source.orderAttribute)
    && order.orderAttribute === 'rental2' && ['partial', 'full'].includes(order.rental2TransferMode)
    && products.length === 1 && products[0].brand === '虚拟产品'
    && products[0].productName === (order.rental2TransferMode === 'partial' ? '部分转租赁2' : '全部转租赁2');
}
function matchingProfile(order, profile) {
  const observed = normalizeIdentity(order), expected = normalizeIdentity(profile);
  return ['consignee', 'phone', 'address'].every(field => observed[field] && observed[field] === expected[field]);
}
function createOrderIngestion(db) {
  const repository = createRepository(db);
  const get = repository.getDocById;
  // Called only from authenticated order entry points, within the order's creation transaction.
  async function prepareOrder(input, actor, store = db) {
    if (!actor || !actor.id) fail('LOGIN_REQUIRED', '请先登录');
    const order = { ...stripLinkFields(input), ...pending(actor) };
    if (!rental(order.orderAttribute)) {
      if (REF_FIELDS.some(field => clean(input[field]))) fail('CUSTOMER_ORDER_UNSUPPORTED', '只有租赁订单可以关联客户');
      order.customerIngestState = 'done'; return order;
    }
    if (input.customerSelectionMode === 'none') { order.customerIngestState = 'done'; return order; }
    const derived = SOURCE_FIELDS.some(field => field.endsWith('OrderId') && clean(input[field]));
    if ((!derived || input.customerSelectionMode === 'explicit') && clean(input.customerId)) {
      const refs = await validateCustomerReferences(repository, input, store);
      await bumpIdentityRevision(repository, store);
      // A temporary recipient edit must not retain a reference to a different saved profile.
      if (refs.recipientProfileId && !matchingProfile(order, await get('customer_recipient_profiles', refs.recipientProfileId, store))) delete refs.recipientProfileId;
      if (refs.customerAliasId) {
        const alias = await get('customer_aliases', refs.customerAliasId, store);
        if (normalizeName(alias.name) !== normalizeName(order.customerName)) delete refs.customerAliasId;
      }
      Object.assign(order, linked(refs, actor, 'manual'));
    } else if ((!derived || input.customerSelectionMode === 'explicit') && (clean(input.customerAliasId) || clean(input.recipientProfileId))) {
      fail('CUSTOMER_REQUIRED', '请选择这些别名或收货档案所属的客户');
    }
    return order;
  }
  async function recordPreparedLink(orderId, order, actor, tx) {
    if (order.customerLinkMethod !== 'manual' || !order.customerId) return;
    const id = createHash('sha256').update(`ingest-v1:${orderId}`).digest('hex');
    await tx.collection('customer_operation_audits').doc(id).set({ data: { action: 'ingestOrder', orderId,
      customerId: order.customerId, actorId: actor.id, method: 'manual', changedFields: REF_FIELDS, createdAt: order.customerLinkedAt } });
  }
  async function inherit(order, tx) {
    const relation = sourceRef(order);
    if (!relation) return null;
    const source = await get('orders', relation.id, tx);
    if (!verifySource(order, source, relation.kind) || !source.customerId || source.customerLinkStatus === 'ignored') {
      fail('CUSTOMER_SOURCE_CONFLICT', '来源订单不能可靠继承客户');
    }
    const refs = { customerId: source.customerId };
    if (source.customerAliasId) refs.customerAliasId = source.customerAliasId;
    if (source.recipientProfileId) {
      const profile = await get('customer_recipient_profiles', source.recipientProfileId, tx);
      if (profile && profile.enabled !== false && matchingProfile(order, profile)) refs.recipientProfileId = source.recipientProfileId;
    }
    return validateCustomerReferences(repository, refs, tx);
  }
  // A library function, never a client-callable action. Actor comes from server auth or the
  // token-authenticated Assist adapter. Missing metadata prevents historical auto-linking.
  async function ingestOrder(orderId, actor) {
    try {
      const order = await get('orders', orderId);
      if (!order || order.customerIngestVersion !== 1 || order.customerIngestState !== 'pending'
        || order.customerId || order.customerLinkStatus !== 'pending' || !rental(order.orderAttribute)) return { status: 'skipped' };
      let relation;
      try { relation = sourceRef(order); } catch (error) { if (!(error instanceof CustomerError)) throw error; return { status: 'pending', code: error.code }; }
      // Assist renewals have no trustworthy client source ID. Resolve a unique source after
      // saving, so source lookup failures cannot fail the already-created renewal order.
      let discoveredSource = false;
      if (!relation && actor.id === 'service:hc-order-assist' && order.importSource === 'hc-order-assist-renewal') {
        const rows = (await db.collection('orders').where({ onlineOrderNumber: order.onlineOrderNumber,
          salesChannel: order.salesChannel }).limit(100).get()).data || [];
        const sources = rows.filter(row => row._id !== orderId && !row.renewalSourceOrderId
          && !['hc-order-assist-renewal', 'hc-order-assist-after-sale'].includes(row.importSource)
          && verifySource(order, row, 'renewal'));
        if (rows.length >= 100 || sources.length !== 1) return { status: 'pending', code: 'CUSTOMER_SOURCE_AMBIGUOUS' };
        relation = { id: sources[0]._id, kind: 'renewal' }; discoveredSource = true;
      }
      let match, revision;
      if (!relation) {
        const config = await get('system_config', 'customer_modeling');
        if (!config || config.autoLinkNewOrders !== true) return { status: 'pending', code: 'AUTO_LINK_DISABLED' };
        revision = await readIdentityRevision(repository);
        match = await matchIdentity(repository, order);
      }
      const tx = await db.startTransaction();
      try {
        const current = await get('orders', orderId, tx);
        if (!current || JSON.stringify(current) !== JSON.stringify(order)) { await tx.rollback(); return { status: 'pending', code: 'ORDER_CHANGED' }; }
        let refs;
        if (relation) {
          refs = await inherit(discoveredSource ? { ...current, renewalSourceOrderId: relation.id } : current, tx);
        }
        else {
          const config = await get('system_config', 'customer_modeling', tx);
          if (!config || config.autoLinkNewOrders !== true || await readIdentityRevision(repository, tx) !== revision) {
            await tx.rollback(); return { status: 'pending', code: 'MATCH_CHANGED' };
          }
          if (match.autoLinkEligible) {
            const candidate = match.candidates.find(item => item.customerId === match.customerId && item.exact);
            const alias = candidate.evidence.filter(item => item.source === 'alias' && item.type === 'name_exact').map(item => item.objectId).sort()[0];
            refs = await validateCustomerReferences(repository, { customerId: candidate.customerId,
              recipientProfileId: [...candidate.exactRecipientProfileIds].sort()[0], ...(alias ? { customerAliasId: alias } : {}) }, tx);
            const profile = await get('customer_recipient_profiles', refs.recipientProfileId, tx);
            if (!matchingProfile(current, profile)) fail('CUSTOMER_MATCH_CHANGED', '收货档案已变化');
          }
        }
        if (refs) await bumpIdentityRevision(repository, tx);
        const patch = refs ? linked(refs, actor, relation ? 'inherited' : 'exact') : { customerIngestState: 'done' };
        if (discoveredSource && refs) {
          const source = await get('orders', relation.id, tx);
          patch.renewalSourceOrderId = relation.id; patch.renewalSourceSerialNumber = source.serialNumber || 0;
        }
        await tx.collection('orders').doc(orderId).update({ data: patch });
        if (refs) {
          const id = createHash('sha256').update(`ingest-v1:${orderId}`).digest('hex');
          await tx.collection('customer_operation_audits').doc(id).set({ data: { action: 'ingestOrder', orderId,
            customerId: refs.customerId, actorId: actor.id, method: patch.customerLinkMethod,
            changedFields: REF_FIELDS, createdAt: patch.customerLinkedAt } });
        }
        await tx.commit();
        return { status: refs ? 'linked' : 'pending', code: match && match.status };
      } catch (error) { await tx.rollback().catch(() => {}); throw error; }
    } catch (error) {
      // The order and pending marker were already committed. Archive scans provide recovery,
      // even when this function is interrupted before it can write a separate task record.
      const code = error instanceof CustomerError ? error.code : 'CUSTOMER_INGEST_FAILED';
      console.warn('客户订单接入待补偿', { orderId, code });
      return { status: 'pending', code };
    }
  }
  return { prepareOrder, recordPreparedLink, ingestOrder };
}
module.exports = { createOrderIngestion, stripLinkFields, verifySource };
