const { NORMALIZATION_VERSION, clean } = require('./normalizers');
const { identitySnapshot, matchSnapshot } = require('./versionedMatcher');
const { fail } = require('./errors');
const { MEMBERS, TASKS, digest, observedIdentity, eligible, memberId, candidateId, requestId, pageSize, transaction, replaceMember } = require('./archiveCommon');
const { findNewOrders } = require('./newOrderScan');
function createScanner(repository) {
  const { db, getDocById } = repository;
  return async function scan(payload, actor) {
    const dryRun = payload.dryRun !== false;
    const scanMode = payload.scanMode || 'all';
    if (!['all', 'new'].includes(scanMode) || (scanMode === 'new' && dryRun)) fail('INVALID_SCAN_MODE', '无效的扫描方式');
    const limit = pageSize(payload.limit);
    let snapshot;
    const matches = new Map();
    async function evidence(order) {
      const id = candidateId(order);
      if (!snapshot) snapshot = identitySnapshot(repository);
      if (!matches.has(id)) matches.set(id, snapshot.then(value => matchSnapshot(value, observedIdentity(order))).then(result => ({
        identityRevision: result.identityRevision,
        matches: result.candidates.slice(0, 50), matchCount: result.candidates.length, matchStatus: result.status,
        evidenceVersion: digest([NORMALIZATION_VERSION, result.candidates, result.issues]),
      })));
      return matches.get(id);
    }
    let task;
    if (!dryRun) {
      const id = requestId(payload.taskId);
      const previous = await getDocById(TASKS, id);
      const plan = scanMode === 'new' && !previous ? await findNewOrders(repository) : null;
      task = await transaction(repository, async tx => {
        const existing = await getDocById(TASKS, id, tx);
        if (existing) return existing;
        const row = { _id: id, scanMode, ...(plan ? { ...plan, totalOrders: plan.orderIds.length } : {}), cursor: '', scanned: 0, eligible: 0, skipped: 0, errorCount: 0, errors: [], status: 'running', createdBy: actor.id, createdAt: new Date().toISOString(), normalizationVersion: NORMALIZATION_VERSION };
        const { _id, ...data } = row;
        await tx.collection(TASKS).doc(_id).set({ data }); return row;
      });
      if ((task.scanMode || 'all') !== scanMode) fail('SCAN_MODE_CHANGED', '请使用原任务的扫描方式继续');
      if (task.normalizationVersion !== NORMALIZATION_VERSION) fail('SCAN_VERSION_CHANGED', '匹配规则已更新，请新建扫描任务');
      if (task.status === 'completed') return { success: true, data: task };
    }
    const cursor = dryRun ? clean(payload.cursor) : task.cursor;
    const query = db.collection('orders').where(cursor ? { _id: db.command.gt(cursor) } : {}).orderBy('_id', 'asc').limit(limit);
    async function recordFailure(error, orderId = '') {
      task = await transaction(repository, async tx => {
        const current = await getDocById(TASKS, task._id, tx);
        // A concurrent worker may already have passed the failing item.
        if (current.status === 'completed' || (orderId && current.cursor >= orderId)) return current;
        const data = { status: 'failed', errorCount: current.errorCount + 1,
          errors: [...(current.errors || []), { orderId, code: error.code || 'SCAN_FAILED' }].slice(-20), updatedAt: new Date().toISOString() };
        await tx.collection(TASKS).doc(task._id).update({ data }); return { ...current, ...data };
      });
      return { success: true, data: task };
    }
    let orders;
    let plannedIds;
    try {
      if (scanMode === 'new') {
        plannedIds = task.orderIds.filter(id => id > cursor).slice(0, limit);
        const rows = plannedIds.length ? (await db.collection('orders').where({ _id: db.command.in(plannedIds) }).limit(limit).get()).data || [] : [];
        const byId = new Map(rows.map(row => [row._id, row]));
        // Deleted planned orders still advance the cursor and count as skipped.
        orders = plannedIds.map(_id => byId.get(_id) || { _id });
      } else orders = (await query.get()).data || [];
    }
    catch (error) { if (dryRun) throw error; return recordFailure(error); }
    const previews = [];
    let drySkipped = 0;
    for (const scanned of orders) {
      try {
        const alreadyKnown = scanMode === 'new' && await getDocById(MEMBERS, memberId(scanned._id));
        const info = eligible(scanned) && !alreadyKnown ? await evidence(scanned) : null;
        if (dryRun) {
          const old = await getDocById(MEMBERS, memberId(scanned._id));
          if (info && !['accepted', 'ignored'].includes(old?.status)) previews.push({ candidateId: candidateId(scanned), orderId: scanned._id, rentalType: scanned.orderAttribute, ...info });
          else drySkipped++;
          continue;
        }
        task = await transaction(repository, async tx => {
          const currentTask = await getDocById(TASKS, task._id, tx);
          // Another caller may already have advanced this task. Never move its cursor backwards.
          if (currentTask.cursor >= scanned._id) return currentTask;
          const order = await getDocById('orders', scanned._id, tx);
          if (order && digest(order) !== digest(scanned)) fail('SCAN_ORDER_CHANGED', '扫描中的订单已变更，请继续任务重试');
          const oldMember = await getDocById(MEMBERS, memberId(scanned._id), tx);
          const available = eligible(order) && (scanMode === 'new' ? !oldMember : !['accepted', 'ignored'].includes(oldMember?.status));
          if (available) {
            const id = candidateId(order);
            const member = { _id: memberId(order._id), orderId: order._id, candidateId: id, rentalType: order.orderAttribute,
              serialNumber: order.serialNumber ?? '', onlineOrderNumber: clean(order.onlineOrderNumber), date: clean(order.date),
              observedIdentity: observedIdentity(order), orderVersion: digest(order), evidenceVersion: info.evidenceVersion,
              status: 'pending', rejectedCustomerIds: oldMember?.evidenceVersion === info.evidenceVersion ? (oldMember.rejectedCustomerIds || []) : [],
              revision: oldMember?.revision || 0,
            };
            const changed = !oldMember || ['candidateId', 'orderVersion', 'evidenceVersion', 'status'].some(key => member[key] !== oldMember[key]);
            if (changed) member.revision++;
            await replaceMember(repository, tx, oldMember, member, { identityFingerprint: id, normalizationVersion: NORMALIZATION_VERSION,
              observedIdentity: member.observedIdentity, ...info, createdAt: new Date().toISOString(),
            });
          } else if (scanMode !== 'new' && oldMember?.status === 'pending') {
            await replaceMember(repository, tx, oldMember, { ...oldMember, status: 'stale', revision: oldMember.revision + 1 });
          }
          const data = { cursor: scanned._id, scanned: currentTask.scanned + 1, eligible: currentTask.eligible + Number(available),
            skipped: currentTask.skipped + Number(!available), status: 'running', updatedAt: new Date().toISOString() };
          await tx.collection(TASKS).doc(task._id).update({ data });
          return { ...currentTask, ...data };
        });
      } catch (error) {
        if (dryRun) throw error;
        return recordFailure(error, scanned._id);
      }
    }
    if (dryRun) return { success: true, data: { dryRun: true, cursor: orders.at(-1)?._id || cursor, completed: orders.length < limit, scanned: orders.length, skipped: drySkipped, previews } };
    if (orders.length < limit || (scanMode === 'new' && task.scanned >= task.orderIds.length)) task = await transaction(repository, async tx => {
      const current = await getDocById(TASKS, task._id, tx);
      await tx.collection(TASKS).doc(task._id).update({ data: { status: 'completed', updatedAt: new Date().toISOString() } });
      return { ...current, status: 'completed' };
    });
    return { success: true, data: task };
  };
}
module.exports = { createScanner };
