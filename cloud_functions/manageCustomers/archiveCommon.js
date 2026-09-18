const { createHash } = require('node:crypto');
const { clean, identityFingerprint, NORMALIZATION_VERSION } = require('./normalizers');
const { fail } = require('./errors');
const CANDIDATES = 'customer_link_candidates';
const MEMBERS = 'customer_link_candidate_members';
const TASKS = 'customer_scan_tasks';
const REQUESTS = 'customer_write_requests';
function stable(value) {
  if (value && typeof value.toJSON === 'function') return stable(value.toJSON());
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const observedIdentity = order => ({ customerName: clean(order.customerName), consignee: clean(order.consignee), phone: clean(order.consigneePhone), address: clean(order.consigneeAddress) });
const eligible = order => !!order && ['rental1', 'rental2'].includes(order.orderAttribute) && !clean(order.customerId) && !['linked', 'ignored'].includes(order.customerLinkStatus);
const memberId = orderId => digest(['customer-order-member', orderId]);
const candidateId = order => identityFingerprint(observedIdentity(order)) || digest([NORMALIZATION_VERSION, 'empty', order._id]);
function requestId(value) {
  const id = clean(value);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) fail('REQUEST_ID_REQUIRED', '请提供有效的任务或请求 ID');
  return id;
}
function pageSize(value, maximum = 100) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, maximum) : 20;
}
async function transaction(repository, work) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await repository.db.startTransaction();
    try { const result = await work(tx); await tx.commit(); return result; }
    catch (error) {
      await tx.rollback().catch(() => {});
      const conflict = error.code === 'CUSTOMER_WRITE_CONFLICT' || error.errCode === -502001 || /transaction.*conflict|write conflict/i.test(error.message || '');
      if (!conflict || attempt === 3) throw error;
    }
  }
}
function memberCounts(member, direction) {
  return member ? { orderCount: direction, pendingCount: member.status === 'pending' ? direction : 0, [member.rentalType === 'rental2' ? 'rental2Count' : 'rental1Count']: direction } : {};
}
async function replaceMember(repository, tx, oldMember, member, candidatePatch = {}) {
  const ids = [...new Set([oldMember?.candidateId, member.candidateId].filter(Boolean))];
  for (const id of ids) {
    const existing = await repository.getDocById(CANDIDATES, id, tx);
    const deltas = [memberCounts(oldMember?.candidateId === id ? oldMember : null, -1), memberCounts(member.candidateId === id ? member : null, 1)];
    const data = { ...(existing || {}), ...(id === member.candidateId ? candidatePatch : {}), updatedAt: new Date().toISOString() };
    delete data._id;
    if (existing?.createdAt) data.createdAt = existing.createdAt;
    for (const field of ['orderCount', 'pendingCount', 'rental1Count', 'rental2Count']) data[field] = (existing?.[field] || 0) + deltas.reduce((n, d) => n + (d[field] || 0), 0);
    data.status = data.pendingCount > 0 ? 'pending' : 'processed';
    await tx.collection(CANDIDATES).doc(id).set({ data });
  }
  const data = { ...member }; delete data._id;
  await tx.collection(MEMBERS).doc(member._id).set({ data });
}
module.exports = { CANDIDATES, MEMBERS, TASKS, REQUESTS, digest, observedIdentity, eligible, memberId, candidateId, requestId, pageSize, transaction, replaceMember };
