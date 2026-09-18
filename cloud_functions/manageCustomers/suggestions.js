const { clean, normalizeName } = require('./normalizers');

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const score = (name, keyword) => name === keyword ? 0 : name.startsWith(keyword) ? 1 : name.includes(keyword) ? 2 : 3;
const aliasView = row => ({ _id: row._id, name: row.name, salesChannel: row.salesChannel || '' });
const recipientView = row => ({ _id: row._id, label: row.label || '', consignee: row.consignee || '', phone: row.phone || '', address: row.address || '' });

function createSuggestions(repository) {
  const { db, fetchAll } = repository;
  return async payload => {
    const keyword = normalizeName(payload.keyword);
    if (!keyword) return { success: true, data: [] };
    if (keyword.length > 100) return { success: false, errMsg: '客户名称最多输入 100 个字符' };
    // Query only matching names/aliases, not all recipient profiles on every keystroke.
    const pattern = keyword.split(' ').map(part => [...part].map(char => {
      const code = char.charCodeAt(0);
      return code >= 33 && code <= 126 ? `[${escape(char)}${escape(String.fromCharCode(code + 65248))}]` : escape(char);
    }).join('')).join('[\\s\\-_·•.。\\u2010-\\u2015]+');
    const regex = db.RegExp({ regexp: pattern, options: 'i' });
    const [direct, aliases] = await Promise.all([
      fetchAll('customers', { status: 'active', displayName: regex }),
      fetchAll('customer_aliases', { enabled: db.command.neq(false), name: regex }),
    ]);
    const customers = new Map(direct.map(row => [row._id, row]));
    const ids = [...new Set(aliases.map(row => row.customerId))].filter(id => !customers.has(id));
    for (let offset = 0; offset < ids.length; offset += 100) {
      const rows = await fetchAll('customers', { _id: db.command.in(ids.slice(offset, offset + 100)), status: 'active' });
      rows.forEach(row => customers.set(row._id, row));
    }
    const matches = new Map();
    aliases.forEach(row => { const group = matches.get(row.customerId) || []; group.push(row); matches.set(row.customerId, group); });
    const rank = row => Math.min(score(normalizeName(row.displayName), keyword), ...(matches.get(row._id) || []).map(alias => score(normalizeName(alias.name), keyword)));
    const selected = [...customers.values()].filter(row => rank(row) < 3).sort((a, b) => rank(a) - rank(b)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a._id).localeCompare(String(b._id))).slice(0, 3);
    const data = await Promise.all(selected.map(async customer => {
      const [allAliases, recipients] = await Promise.all([
        fetchAll('customer_aliases', { customerId: customer._id, enabled: db.command.neq(false) }),
        fetchAll('customer_recipient_profiles', { customerId: customer._id, enabled: db.command.neq(false) }),
      ]);
      allAliases.sort((a, b) => score(normalizeName(a.name), keyword) - score(normalizeName(b.name), keyword)
        || Number(b.salesChannel === clean(payload.salesChannel)) - Number(a.salesChannel === clean(payload.salesChannel))
        || String(a._id).localeCompare(String(b._id)));
      recipients.sort((a, b) => Number(b.useCount || 0) - Number(a.useCount || 0)
        || String(b.lastUsedAt || b.updatedAt || '').localeCompare(String(a.lastUsedAt || a.updatedAt || ''))
        || String(a._id).localeCompare(String(b._id)));
      return { _id: customer._id, displayName: customer.displayName, aliases: allAliases.slice(0, 3).map(aliasView),
        recipients: recipients.slice(0, 1).map(recipientView), aliasTotal: allAliases.length, recipientTotal: recipients.length };
    }));
    return { success: true, data };
  };
}
module.exports = { createSuggestions };
