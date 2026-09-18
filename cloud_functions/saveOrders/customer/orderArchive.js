const { createHash } = require('node:crypto');
const { createRepository } = require('./repository');
const { matchIdentity } = require('./matcher');
const { readIdentityRevision, bumpIdentityRevision } = require('./identityRevision');
const { aliasData, recipientData } = require('./records');
const { clean, normalizeName, NORMALIZATION_VERSION } = require('./normalizers');
const { fail } = require('./errors');

const rental = value => ['rental1', 'rental2', '租赁1', '租赁2'].includes(value);
const digest = value => createHash('sha256').update(value).digest('hex');

// Both callers require customers:write. The persisted request is set by saveOrders,
// never accepted from a retry payload. An order ID is the idempotency key.
function createOrderArchive(db) {
  const repository = createRepository(db);
  const get = repository.getDocById;
  return async function archiveOrder(orderId, actor) {
    if (!actor?.id) fail('LOGIN_REQUIRED', '请先登录');
    const order = await get('orders', clean(orderId));
    if (!order || !order.customerArchiveRequested || !rental(order.orderAttribute)) {
      fail('ARCHIVE_NOT_REQUESTED', '此订单未申请随单建档');
    }
    if (order.customerId) return { status: 'linked', customerId: order.customerId };
    if (order.customerLinkStatus === 'ignored') fail('ARCHIVE_IGNORED', '订单已忽略归档');
    if (!normalizeName(order.customerName)) fail('INVALID_CUSTOMER_NAME', '客户名称不能为空');

    const revision = await readIdentityRevision(repository);
    const match = await matchIdentity(repository, order);
    // Never silently merge or create a second identity, even if only a phone or
    // recipient matches. An operator can review these orders in customer archives.
    if (match.status === 'invalid_cluster') return { status: 'pending', code: 'CUSTOMER_MATCH_UNAVAILABLE', message: '客户资料需核对，请稍后归档' };
    if (match.candidates.length) return { status: 'pending', code: 'CUSTOMER_POSSIBLE_DUPLICATE', message: '发现相似客户，请选择已有档案或在客户管理中核对归档' };

    const tx = await db.startTransaction();
    try {
      const current = await get('orders', order._id, tx);
      if (current?.customerId) { await tx.rollback(); return { status: 'linked', customerId: current.customerId }; }
      if (JSON.stringify(current) !== JSON.stringify(order)
        || await readIdentityRevision(repository, tx) !== revision) {
        fail('CUSTOMER_WRITE_CONFLICT', '客户或订单资料已变化，请重试建档');
      }
      const customerId = digest(`order-archive:${order._id}`);
      const aliasId = digest(`order-archive-alias:${order._id}`);
      const recipientId = digest(`order-archive-recipient:${order._id}`);
      // A previous archive must never be overwritten after a later manual unlink.
      if (await get('customers', customerId, tx)) fail('ARCHIVE_ALREADY_CREATED', '此订单曾建立档案，请手动核对关联');
      const time = new Date().toISOString();
      const metadata = { createdAt: time, updatedAt: time, createdBy: actor.id, updatedBy: actor.id };
      await bumpIdentityRevision(repository, tx);
      await tx.collection('customers').doc(customerId).set({ data: {
        displayName: clean(order.customerName), normalizedDisplayName: normalizeName(order.customerName),
        normalizationVersion: NORMALIZATION_VERSION, status: 'active', remark: '', writeRevision: 1, ...metadata,
      } });
      await tx.collection('customer_aliases').doc(aliasId).set({ data: {
        customerId, ...aliasData({ name: order.customerName, salesChannel: order.salesChannel, sourceType: 'order' }), ...metadata,
      } });
      const recipient = recipientData({ consignee: order.consignee, phone: order.consigneePhone,
        address: order.consigneeAddress, sourceType: 'order' });
      const hasRecipient = !!(recipient.normalizedConsignee && recipient.normalizedPhone && recipient.normalizedAddress);
      if (hasRecipient) await tx.collection('customer_recipient_profiles').doc(recipientId).set({ data: {
        customerId, ...recipient, useCount: 0, lastUsedAt: '', ...metadata,
      } });
      await tx.collection('orders').doc(order._id).update({ data: {
        customerId, customerAliasId: aliasId, recipientProfileId: hasRecipient ? recipientId : '',
        customerLinkStatus: 'linked', customerLinkMethod: 'manual', customerLinkedAt: time,
        customerLinkedBy: actor.id, customerIngestState: 'done',
      } });
      await tx.collection('customer_operation_audits').doc(digest(`order-archive-audit:${order._id}`)).set({ data: {
        action: 'createFromOrder', orderId: order._id, customerId, actorId: actor.id, createdAt: time,
        changedFields: ['customerId', 'customerAliasId', 'recipientProfileId'],
      } });
      await tx.commit();
      return { status: 'created', customerId, recipientSaved: hasRecipient };
    } catch (error) { await tx.rollback().catch(() => {}); throw error; }
  };
}
module.exports = { createOrderArchive };
