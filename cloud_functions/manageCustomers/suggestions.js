const { clean, normalizeName } = require('./normalizers');

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const score = (name, keyword) => name === keyword ? 0 : name.startsWith(keyword) ? 1 : name.includes(keyword) ? 2 : 3;
const CANDIDATE_LIMIT = 20;
const CUSTOMER_FIELDS = { _id: true, displayName: true, updatedAt: true };
const ALIAS_FIELDS = { _id: true, customerId: true, name: true, salesChannel: true };

function createSuggestions({ db }) {
  const read = async (collection, where, fields) =>
    (await db.collection(collection).where(where).field(fields).limit(CANDIDATE_LIMIT).get()).data || [];
  return async payload => {
    const keyword = normalizeName(payload.keyword);
    if (!keyword) return { success: true, data: [] };
    if (keyword.length > 100) return { success: false, errMsg: '客户名称最多输入 100 个字符' };
    // Normalized fields must be backfilled before release. Exact equality uses the
    // existing name indexes; broader tiers run only if fewer than three customers match.
    const pattern = escape(keyword);
    const tiers = [keyword, db.RegExp({ regexp: `^${pattern}.+`, options: '' }),
      db.RegExp({ regexp: `^(?!${pattern}).*${pattern}`, options: '' })];
    const customers = new Map(), matches = new Map(), resolved = new Set();
    for (const name of tiers) {
      const [direct, aliases] = await Promise.all([
        read('customers', { status: 'active', normalizedDisplayName: name }, CUSTOMER_FIELDS),
        read('customer_aliases', { enabled: db.command.neq(false), normalizedName: name }, ALIAS_FIELDS),
      ]);
      direct.forEach(row => customers.set(row._id, row));
      const ids = [...new Set(aliases.map(row => row.customerId))].filter(id => id && !customers.has(id) && !resolved.has(id));
      if (ids.length) {
        const owners = await read('customers', { _id: db.command.in(ids), status: 'active' }, CUSTOMER_FIELDS);
        owners.forEach(row => customers.set(row._id, row));
        ids.forEach(id => resolved.add(id));
      }
      aliases.forEach(row => {
        if (!customers.has(row.customerId)) return;
        const group = matches.get(row.customerId) || [];
        if (!group.some(alias => alias._id === row._id)) group.push(row);
        matches.set(row.customerId, group);
      });
      if (customers.size >= 3) break;
    }
    const rank = row => Math.min(score(normalizeName(row.displayName), keyword), ...(matches.get(row._id) || []).map(alias => score(normalizeName(alias.name), keyword)));
    const data = [...customers.values()].sort((a, b) => rank(a) - rank(b)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a._id).localeCompare(String(b._id)))
      .slice(0, 3).map(customer => {
        const aliases = (matches.get(customer._id) || []).sort((a, b) => score(normalizeName(a.name), keyword) - score(normalizeName(b.name), keyword)
          || Number(b.salesChannel === clean(payload.salesChannel)) - Number(a.salesChannel === clean(payload.salesChannel))
          || String(a._id).localeCompare(String(b._id))).slice(0, 3)
          .map(row => ({ _id: row._id, name: row.name, salesChannel: row.salesChannel || '' }));
        // Retain the legacy shape for older frontends. Counts are not totals when
        // detailsDeferred is true; the selection endpoint supplies authoritative details.
        return { _id: customer._id, displayName: customer.displayName, aliases, recipients: [],
          aliasTotal: aliases.length, recipientTotal: 0, detailsDeferred: true };
      });
    return { success: true, data };
  };
}
module.exports = { createSuggestions };
