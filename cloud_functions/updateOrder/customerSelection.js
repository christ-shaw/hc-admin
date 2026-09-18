const { randomUUID } = require('node:crypto');
const { createRepository } = require('./customer/repository');
const { validateCustomerReferences } = require('./customer/cluster');
const { normalizeName, normalizeIdentity, clean } = require('./customer/normalizers');
const { bumpIdentityRevision } = require('./customer/identityRevision');

const fields = ['customerId', 'customerAliasId', 'recipientProfileId'];
// Explicit edits are validated and committed together with the order snapshot.
async function applyCustomerSelection(db, tx, existing, input, nextOrder, actor) {
  if (!['explicit', 'none'].includes(input.customerSelectionMode)) return {};
  const expected = input.customerLinkExpected;
  if (!expected || fields.some(field => clean(expected[field]) !== clean(existing[field]))) {
    throw new Error('客户关联已变化，请重新打开订单后选择');
  }
  const repository = createRepository(db);
  let refs = { customerId: '', customerAliasId: '', recipientProfileId: '' };
  if (input.customerSelectionMode === 'explicit') {
    if (!['rental1', 'rental2', '租赁1', '租赁2'].includes(nextOrder.orderAttribute)) throw new Error('只有租赁订单可以关联客户');
    refs = { ...refs, ...await validateCustomerReferences(repository, input, tx) };
    if (refs.customerAliasId) {
      const alias = await repository.getDocById('customer_aliases', refs.customerAliasId, tx);
      if (normalizeName(alias.name) !== normalizeName(nextOrder.customerName)) refs.customerAliasId = '';
    }
    if (refs.recipientProfileId) {
      const recipient = await repository.getDocById('customer_recipient_profiles', refs.recipientProfileId, tx);
      const actual = normalizeIdentity(nextOrder), saved = normalizeIdentity(recipient);
      if (['consignee', 'phone', 'address'].some(field => !actual[field] || actual[field] !== saved[field])) refs.recipientProfileId = '';
    }
  }
  if (fields.every(field => clean(existing[field]) === refs[field]) && existing.customerIngestState === 'done') return {};
  const at = new Date().toISOString();
  const patch = { ...refs, customerLinkStatus: refs.customerId ? 'linked' : 'pending',
    customerLinkMethod: refs.customerId ? 'manual' : '', customerLinkedAt: refs.customerId ? at : '',
    customerLinkedBy: refs.customerId ? actor.id : '', customerLinkIgnoreReason: '', customerIngestState: 'done' };
  await bumpIdentityRevision(repository, tx);
  await tx.collection('customer_operation_audits').doc(randomUUID()).set({ data: {
    action: refs.customerId ? 'editOrderCustomer' : 'unlinkOrderCustomer', orderId: existing._id,
    customerId: refs.customerId, actorId: actor.id, createdAt: at,
    before: Object.fromEntries(fields.map(field => [field, clean(existing[field])])), after: refs,
  } });
  return patch;
}
module.exports = { applyCustomerSelection };
