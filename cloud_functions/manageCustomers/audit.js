// Store IDs and changed field names only, never full names/phones/addresses in audit or logs.
async function recordAudit(transaction, id, { action, actorId, objectId, customerId, changedFields, time }) {
  await transaction.collection('customer_operation_audits').doc(id).set({ data: {
    action, actorId, objectId, customerId, changedFields, createdAt: time,
  } });
}
module.exports = { recordAudit };
