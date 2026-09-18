// Compound indexes accelerate selection and the later archive/relation stages.
// Request/audit/task IDs are deterministic document IDs; no globally unique customer name.
const schema = {
  customers: [['status', 'normalizedDisplayName'], ['mergedIntoCustomerId']],
  customer_aliases: [['normalizedName', 'enabled'], ['customerId', 'enabled']],
  customer_recipient_profiles: [['normalizedPhone', 'enabled'], ['normalizedAddress', 'enabled'], ['customerId', 'enabled']],
  customer_relations: [['fromCustomerId', 'type'], ['toCustomerId', 'type']],
  customer_link_candidates: [['status', 'updatedAt'], ['identityFingerprint']],
  customer_relation_candidates: [['status', 'updatedAt'], ['pairKey']],
  customer_merge_events: [['sourceCustomerId', 'createdAt'], ['targetCustomerId', 'createdAt']],
  customer_write_requests: [['actorId', 'createdAt'], ['actorId', 'action', 'status', 'createdAt']],
  customer_operation_audits: [['customerId', 'createdAt'], ['actorId', 'createdAt']],
  customer_scan_tasks: [['status', 'updatedAt']],
  customer_link_candidate_members: [['candidateId', 'status'], ['candidateId', 'status', 'serialNumber'], ['orderId']],
  orders: [['customerId', 'date'], ['customerLinkStatus', 'date']],
};
const manifest = Object.fromEntries(Object.entries(schema).map(([name, indexes]) => [name, indexes.map(fields => ({
  Name: `cm_${fields.join('_')}`, Keys: fields.map(Name => ({ Name, Direction: '1' })), Unique: false,
}))]));
function planSchema(structure) {
  const operations = [], conflicts = [];
  for (const [collection, expected] of Object.entries(manifest)) {
    if (!Object.hasOwn(structure, collection)) operations.push({ action: 'createCollection', collection });
    const actual = structure[collection] || [];
    for (const index of expected) {
      const keySignature = keys => JSON.stringify((keys || []).map(key => [key.Name, String(key.Direction)]));
      const equivalent = row => keySignature(row.Keys) === keySignature(index.Keys) && Boolean(row.Unique) === index.Unique
        && !row.Sparse && !row.PartialFilterExpression;
      const named = actual.find(row => row.Name === index.Name);
      if (named && !equivalent(named)) conflicts.push({ collection, index: index.Name });
      else if (!actual.some(equivalent)) operations.push({ action: 'createIndex', collection, index });
    }
  }
  return { operations, conflicts };
}
async function applySchema(structure, adapter) {
  const plan = planSchema(structure);
  if (plan.conflicts.length) throw new Error('现有同名索引定义不一致，请先人工核对');
  for (const op of plan.operations) {
    if (op.action === 'createCollection') await adapter.create(op.collection);
    else await adapter.index(op.collection, op.index);
  }
  // Index builds can be asynchronous; a nonempty verification plan must not report success.
  return planSchema(await adapter.read());
}
module.exports = { manifest, planSchema, applySchema };
