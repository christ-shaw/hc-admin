// In-memory document store with isolated transactions and optimistic conflict detection.
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function database(data, { failCollection, failWriteCollection, loseCommitReply = false, beforeCommit } = {}) {
  const reads = [], writes = [], errors = [];
  const versions = new Map();
  let lost = false, nextId = 0;
  const key = (collection, id) => `${collection}/${id}`;
  function store(snapshot, transaction) {
    function query(collection, options = {}) {
      const next = patch => query(collection, { ...options, ...patch });
      function selected() {
        if (collection === failCollection) throw new Error('failure including private phone 13800138000');
        let rows = (snapshot[collection] || []).filter(row => Object.entries(options.where || {}).every(([field, value]) =>
          value && typeof value === 'object' && 'regexp' in value ? new RegExp(value.regexp, value.options).test(row[field] || '')
          : value && typeof value === 'object' && 'in' in value ? value.in.includes(row[field])
          : value && typeof value === 'object' && 'neq' in value ? row[field] !== value.neq : value && typeof value === 'object' && 'gt' in value ? row[field] > value.gt : row[field] === value));
        if (options.sort) rows = [...rows].sort((a, b) => String(a[options.sort] || '').localeCompare(String(b[options.sort] || '')) * (options.direction === 'desc' ? -1 : 1));
        return rows;
      }
      return {
        async add({ data: row }) {
          const id = row._id || `test-${++nextId}`;
          if ((snapshot[collection] || []).some(item => item._id === id)) throw Object.assign(new Error('duplicate'), { errCode: -502001 });
          await query(collection).doc(id).set({ data: row });
          return { _id: id };
        },
        where: where => next({ where }), orderBy: (sort, direction) => next({ sort, direction }),
        skip: skip => next({ skip }), limit: limit => next({ limit }), field: field => next({ field }),
        async get() {
          reads.push({ collection, ...options });
          return { data: selected().slice(options.skip || 0, (options.skip || 0) + (options.limit ?? 100)).map(row => options.field ? Object.fromEntries(Object.keys(options.field).filter(field => field in row).map(field => [field, row[field]])) : clone(row)) };
        },
        async count() { reads.push({ collection, count: true }); return { total: selected().length }; },
        doc(id) {
          const track = () => { if (transaction) transaction.reads.set(key(collection, id), transaction.versions.get(key(collection, id)) || 0); };
          async function save(row) {
            if (collection === failWriteCollection) throw new Error('injected write failure');
            track();
            const rows = snapshot[collection] ||= [];
            const index = rows.findIndex(item => item._id === id);
            const saved = { ...clone(row), _id: id };
            if (index < 0) rows.push(saved); else rows[index] = saved;
            if (transaction) transaction.writes.set(key(collection, id), { collection, id, data: saved });
            else { versions.set(key(collection, id), (versions.get(key(collection, id)) || 0) + 1); writes.push({ collection, id, data: saved }); }
          }
          return {
            async get() { track(); reads.push({ collection, id }); if (collection === failCollection) throw new Error('private phone 13800138000'); return { data: clone((snapshot[collection] || []).find(row => row._id === id)) || null }; },
            async set({ data: row }) { await save(row); },
            async update({ data: patch }) { const row = (snapshot[collection] || []).find(item => item._id === id); if (!row) throw new Error('document not found'); const values = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, value && value.__push ? [...(row[field] || []), ...value.__push] : value])); await save({ ...row, ...clone(values) }); return { stats: { updated: 1 } }; },
          };
        },
      };
    }
    return { collection: query };
  }
  const db = { ...store(data), RegExp: value => value, serverDate: () => '2026-09-07T01:00:00.000Z', command: { in: value => ({ in: value }), push: value => ({ __push: value }), neq: value => ({ neq: value }), gt: value => ({ gt: value }) }, async startTransaction() {
    const tx = { reads: new Map(), writes: new Map(), versions: new Map(versions) };
    return { ...store(clone(data), tx), async rollback() {}, async commit() {
      if (beforeCommit) await beforeCommit([...tx.writes.values()]);
      for (const [id, version] of tx.reads) if ((versions.get(id) || 0) !== version) throw Object.assign(new Error('transaction conflict'), { code: 'CUSTOMER_WRITE_CONFLICT' });
      for (const [id, write] of tx.writes) {
        const rows = data[write.collection] ||= [];
        const index = rows.findIndex(row => row._id === write.id);
        if (index < 0) rows.push(clone(write.data)); else rows[index] = clone(write.data);
        versions.set(id, (versions.get(id) || 0) + 1); writes.push(clone(write));
      }
      if (loseCommitReply && !lost) { lost = true; throw new Error('connection lost after commit'); }
    } };
  } };
  return { db, reads, writes, errors };
}
module.exports = { database };
