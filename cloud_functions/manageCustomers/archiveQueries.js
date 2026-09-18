const { clean } = require('./normalizers');
const { fail } = require('./errors');
const { CANDIDATES, MEMBERS, TASKS, REQUESTS, pageSize } = require('./archiveCommon');
function createArchiveQueries(repository) {
  return async function list(payload, actor) {
    const view = payload.view || 'candidates';
    const page = Number.isSafeInteger(payload.page) && payload.page > 0 ? payload.page : 1;
    const size = pageSize(payload.pageSize, 50);
    let collection, where = {}, sort = '_id';
    if (view === 'candidates') {
      collection = CANDIDATES;
      const status = payload.status || 'pending';
      if (!['pending', 'processed', 'all'].includes(status)) fail('INVALID_ARCHIVE_FILTER', '无效的候选筛选');
      if (status !== 'all') where.status = status;
    } else if (view === 'members') {
      collection = MEMBERS; sort = 'serialNumber';
      if (!clean(payload.candidateId)) fail('CANDIDATE_REQUIRED', '请选择候选组');
      where.candidateId = clean(payload.candidateId);
      const status = payload.status || 'pending';
      if (!['pending', 'accepted', 'ignored', 'stale', 'all'].includes(status)) fail('INVALID_ARCHIVE_FILTER', '无效的订单筛选');
      if (status !== 'all') where.status = status;
    } else if (view === 'requests') {
      collection = REQUESTS; where = { actorId: actor.id, action: 'resolveLinkCandidate', status: 'running' }; sort = 'createdAt';
    } else if (view === 'tasks') { collection = TASKS; sort = 'createdAt'; }
    else fail('INVALID_ARCHIVE_VIEW', '不支持的归档查询');
    const query = repository.db.collection(collection).where(where);
    const [rows, count] = await Promise.all([query.orderBy(sort, sort === 'createdAt' ? 'desc' : 'asc').skip((page - 1) * size).limit(size).get(), query.count()]);
    let data = rows.data || [];
    if (view === 'requests') data = data.map(row => ({ requestId: row.requestId, status: row.status, next: row.next, total: row.plan.members.length, mode: row.plan.mode, createdAt: row.createdAt }));
    if (view === 'candidates') {
      const names = new Map();
      data = await Promise.all(data.map(async row => ({ ...row, matches: await Promise.all((row.matches || []).map(async match => {
        if (!names.has(match.customerId)) names.set(match.customerId, repository.getDocById('customers', match.customerId));
        return { ...match, displayName: (await names.get(match.customerId))?.displayName || '客户已不存在' };
      })) })));
    }
    return { success: true, data, total: count.total, page, pageSize: size };
  };
}
module.exports = { createArchiveQueries };
