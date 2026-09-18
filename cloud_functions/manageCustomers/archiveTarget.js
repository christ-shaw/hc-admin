const { bumpIdentityRevision } = require('./identityRevision');
const { aliasData, recipientData } = require('./records');
const { normalizeName, clean, NORMALIZATION_VERSION } = require('./normalizers');
const { resolveCustomer, validateCustomerReferences } = require('./cluster');
const { fail } = require('./errors');
const { digest } = require('./archiveCommon');

// Called only after an explicitly selected order passed the archive preconditions.
// The initial target and optional child records commit with that first order.
async function archiveTarget(repository, tx, request, actor) {
  const { plan } = request;
  const get = (collection, id, store = tx) => repository.getDocById(collection, id, store);
  const time = new Date().toISOString();
  const audit = { createdAt: time, createdBy: actor.id, updatedAt: time, updatedBy: actor.id };
  if (request.target) return validateCustomerReferences(repository, request.target, tx);
  let customerId, parent, aliases = [], recipients = [];
  if (plan.mode === 'create') {
    customerId = digest([request._id, 'customer']);
    if (await get('customers', customerId)) fail('CUSTOMER_WRITE_CONFLICT', '客户建档状态已变更，请重试');
    await bumpIdentityRevision(repository, tx);
    await tx.collection('customers').doc(customerId).set({ data: { displayName: plan.displayName,
      normalizedDisplayName: normalizeName(plan.displayName), normalizationVersion: NORMALIZATION_VERSION,
      status: 'active', remark: plan.remark, writeRevision: 1, ...audit,
    } });
    const alias = { _id: digest([request._id, 'primaryAlias']), customerId, ...aliasData({ name: plan.displayName }), ...audit };
    const { _id, ...data } = alias;
    await tx.collection('customer_aliases').doc(_id).set({ data }); aliases = [alias];
  } else {
    // Read parent before scanning aliases/profiles; writer increments this revision for every change.
    const resolved = await resolveCustomer(plan.customerId, id => get('customers', id, repository.db));
    customerId = resolved.customer._id; parent = resolved.customer;
    [aliases, recipients] = await Promise.all([
      repository.fetchAll('customer_aliases', { customerId }), repository.fetchAll('customer_recipient_profiles', { customerId }),
    ]);
    const current = (await resolveCustomer(plan.customerId, id => get('customers', id))).customer;
    if (current._id !== customerId || (current.writeRevision || 0) !== (parent.writeRevision || 0)) fail('CUSTOMER_WRITE_CONFLICT', '客户资料已变更，请重试');
    // Validate client references before any writes so invalid selections can be recorded as conflicts.
    if (plan.customerAliasId || plan.recipientProfileId) await validateCustomerReferences(repository, { customerId,
      ...(plan.customerAliasId ? { customerAliasId: plan.customerAliasId } : {}), ...(plan.recipientProfileId ? { recipientProfileId: plan.recipientProfileId } : {}),
    }, tx);

    await bumpIdentityRevision(repository, tx);
    await tx.collection('customers').doc(customerId).update({ data: { writeRevision: (current.writeRevision || 0) + 1, updatedAt: time, updatedBy: actor.id } });
  }
  const refs = { customerId, ...(plan.customerAliasId ? { customerAliasId: plan.customerAliasId } : {}), ...(plan.recipientProfileId ? { recipientProfileId: plan.recipientProfileId } : {}) };
  if (plan.newAlias) {
    const data = aliasData(plan.newAlias);
    const duplicate = aliases.find(row => row.enabled !== false && normalizeName(row.name) === data.normalizedName && clean(row.salesChannel) === data.salesChannel);
    refs.customerAliasId = duplicate?._id || digest([request._id, 'alias']);
    if (!duplicate) await tx.collection('customer_aliases').doc(refs.customerAliasId).set({ data: { customerId, ...data, ...audit } });
  }
  if (plan.newRecipient) {
    const data = recipientData(plan.newRecipient);
    const duplicate = recipients.find(row => {
      const normalized = recipientData(row);
      return row.enabled !== false && ['normalizedConsignee', 'normalizedPhone', 'normalizedAddress'].every(key => normalized[key] === data[key]);
    });
    refs.recipientProfileId = duplicate?._id || digest([request._id, 'recipient']);
    if (!duplicate) await tx.collection('customer_recipient_profiles').doc(refs.recipientProfileId).set({ data: { customerId, ...data, useCount: 0, lastUsedAt: '', ...audit } });
  }
  return refs;
}
module.exports = { archiveTarget };
