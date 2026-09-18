const {
  NORMALIZATION_VERSION, normalizeName, normalizePhone, normalizeAddress,
} = require('../cloud_functions/manageCustomers/normalizers');

const COLLECTION_FIELDS = Object.freeze({
  customers: { displayName: ['normalizedDisplayName', normalizeName] },
  customer_aliases: { name: ['normalizedName', normalizeName] },
  customer_recipient_profiles: {
    consignee: ['normalizedConsignee', normalizeName],
    phone: ['normalizedPhone', normalizePhone],
    address: ['normalizedAddress', normalizeAddress],
  },
});

function derivePatch(collection, record) {
  const fields = COLLECTION_FIELDS[collection];
  if (!fields) throw new Error('不支持回填此集合');
  const expected = { normalizationVersion: NORMALIZATION_VERSION };
  for (const [source, [target, normalize]] of Object.entries(fields)) expected[target] = normalize(record[source]);
  return Object.fromEntries(Object.entries(expected).filter(([key, value]) => record[key] !== value));
}

function updateCommand(collection, record, patch) {
  // Compare source and derived fields to prevent overwriting an intervening edit or backfill.
  const keys = [...Object.keys(COLLECTION_FIELDS[collection]), ...Object.keys(patch)];
  const filter = { _id: record._id };
  for (const key of keys) filter[key] = record[key] === undefined ? { $exists: false } : { $eq: record[key] };
  return {
    TableName: collection, CommandType: 'UPDATE',
    Command: JSON.stringify({ update: collection, updates: [{ q: filter, u: { $set: patch }, upsert: false, multi: false }] }),
  };
}

function aliasCollisions(aliases) {
  const groups = new Map();
  for (const alias of aliases) {
    if (alias.enabled === false) continue;
    const key = JSON.stringify([alias.customerId, normalizeName(alias.name), String(alias.salesChannel || '').trim()]);
    const group = groups.get(key) || { customerId: alias.customerId, aliasIds: [] };
    group.aliasIds.push(alias._id);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.aliasIds.length > 1);
}

function preview(collections) {
  const changes = [];
  const counts = {};
  for (const collection of Object.keys(COLLECTION_FIELDS)) {
    const rows = collections[collection] || [];
    counts[collection] = { scanned: rows.length, changed: 0 };
    for (const row of rows) {
      const fields = Object.keys(derivePatch(collection, row));
      if (!fields.length) continue;
      counts[collection].changed++;
      changes.push({ collection, id: row._id, changedFields: fields });
    }
  }
  return { normalizationVersion: NORMALIZATION_VERSION, counts, changes, aliasCollisions: aliasCollisions(collections.customer_aliases || []) };
}

module.exports = { COLLECTION_FIELDS, derivePatch, updateCommand, preview };
