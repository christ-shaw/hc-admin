// All application writes to identity data participate in this revision. Matching reads it
// before scanning and again in its commit transaction, including newly inserted customers.
async function readIdentityRevision(repository, store = repository.db) {
  const row = await repository.getDocById('system_config', 'customer_identity_revision', store);
  return Number(row && row.revision) || 0;
}
async function bumpIdentityRevision(repository, store) {
  const revision = await readIdentityRevision(repository, store);
  await store.collection('system_config').doc('customer_identity_revision').set({ data: { revision: revision + 1 } });
}
module.exports = { readIdentityRevision, bumpIdentityRevision };
