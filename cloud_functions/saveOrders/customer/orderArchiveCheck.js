const { randomBytes } = require('node:crypto');
const { identityFingerprint, NORMALIZATION_VERSION } = require('./normalizers');
const { fail } = require('./errors');

// Store the server's completed check, not a client-supplied "no duplicates" flag.
// This namespace shares the existing server-only request collection.
const COLLECTION = 'customer_write_requests';
async function rememberArchiveCheck(repository, identity, result, actor) {
  if (!actor?.id || result.status === 'invalid_cluster' || !Array.isArray(result.candidates)
    || result.candidates.length || !identityFingerprint(identity)) return result;
  const archiveCheckId = `order-check-${randomBytes(24).toString('hex')}`;
  await repository.db.collection(COLLECTION).doc(archiveCheckId).set({ data: {
    kind: 'orderArchiveCheck', actorId: actor.id, identityFingerprint: identityFingerprint(identity),
    normalizationVersion: NORMALIZATION_VERSION, createdAt: new Date().toISOString(), orderId: '',
  } });
  return { ...result, archiveCheckId };
}

async function consumeArchiveCheck(repository, order, store) {
  const id = order.customerArchiveCheckId;
  if (typeof id !== 'string' || !/^order-check-[a-f0-9]{48}$/.test(id)) {
    fail('CUSTOMER_ARCHIVE_CHECK_INVALID', '客户检查结果无效，订单已保存，可稍后归档');
  }
  const check = await repository.getDocById(COLLECTION, id, store);
  if (!check || check.kind !== 'orderArchiveCheck' || check.actorId !== order.customerIngestActor
    || check.normalizationVersion !== NORMALIZATION_VERSION
    || check.identityFingerprint !== identityFingerprint(order)
    || (check.orderId && check.orderId !== order._id)) {
    fail('CUSTOMER_ARCHIVE_CHECK_INVALID', '客户检查结果与本单不一致，订单已保存，可稍后归档');
  }
  // No identity revision comparison or matching here. Reuse the original decision.
  await store.collection(COLLECTION).doc(id).update({ data: { orderId: order._id } });
}

module.exports = { rememberArchiveCheck, consumeArchiveCheck };
