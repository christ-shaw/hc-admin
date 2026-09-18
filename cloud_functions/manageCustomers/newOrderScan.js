const { MEMBERS, eligible, memberId } = require('./archiveCommon');

const NEW_SCAN_LIMIT = 500;

// Reconcile lightweight IDs instead of reusing a completed task's random-ID cursor.
// Only unseen eligible orders enter the bounded plan; existing candidates are untouched.
async function findNewOrders(repository) {
  const { db } = repository;
  const orderIds = [];
  let cursor = '';
  for (;;) {
    const where = { orderAttribute: db.command.in(['rental1', 'rental2']) };
    if (cursor) where._id = db.command.gt(cursor);
    const rows = (await db.collection('orders').where(where)
      .field({ _id: true, orderAttribute: true, customerId: true, customerLinkStatus: true })
      .orderBy('_id', 'asc').limit(100).get()).data || [];
    const eligibleRows = rows.filter(eligible);
    if (eligibleRows.length) {
      const members = (await db.collection(MEMBERS)
        .where({ _id: db.command.in(eligibleRows.map(row => memberId(row._id))) })
        .field({ _id: true }).limit(100).get()).data || [];
      const existing = new Set(members.map(row => row._id));
      for (const row of eligibleRows) {
        if (existing.has(memberId(row._id))) continue;
        if (orderIds.length === NEW_SCAN_LIMIT) return { orderIds, hasMoreNewOrders: true };
        orderIds.push(row._id);
      }
    }
    if (rows.length < 100) return { orderIds, hasMoreNewOrders: false };
    cursor = rows[rows.length - 1]._id;
  }
}

module.exports = { findNewOrders, NEW_SCAN_LIMIT };
