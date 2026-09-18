const { clean, normalizeName } = require('./normalizers');
const { recipientData } = require('./records');
const { CustomerError, fail } = require('./errors');
const { archiveTarget } = require('./archiveTarget');
const { CANDIDATES, MEMBERS, REQUESTS, digest, eligible, candidateId, requestId, transaction, replaceMember } = require('./archiveCommon');
function parsePlan(payload) {
  if (!['create', 'link', 'ignore', 'reject'].includes(payload.mode)) fail('INVALID_ARCHIVE_ACTION', '请选择归档处理方式');
  if (!Array.isArray(payload.members) || !payload.members.length || payload.members.length > 100) fail('INVALID_ARCHIVE_SELECTION', '每次请选择 1～100 条订单');
  const members = payload.members.map(row => ({ memberId: clean(row.memberId), revision: row.revision }));
  if (members.some(row => !row.memberId || !Number.isSafeInteger(row.revision) || row.revision < 1) || new Set(members.map(row => row.memberId)).size !== members.length) fail('INVALID_ARCHIVE_SELECTION', '订单选择无效或重复，请刷新后选择');
  const plan = { mode: payload.mode, candidateId: clean(payload.candidateId), evidenceVersion: clean(payload.evidenceVersion),
    members: members.sort((a, b) => a.memberId.localeCompare(b.memberId)), customerId: clean(payload.customerId),
    customerAliasId: clean(payload.customerAliasId), recipientProfileId: clean(payload.recipientProfileId),
    displayName: clean(payload.displayName), remark: clean(payload.remark), reason: clean(payload.reason),
  };
  if (!plan.candidateId || !plan.evidenceVersion) fail('INVALID_ARCHIVE_SELECTION', '缺少候选或证据版本');
  if (['link', 'reject'].includes(plan.mode) && !plan.customerId) fail('CUSTOMER_REQUIRED', '请选择客户');
  if (plan.mode === 'create' && !normalizeName(plan.displayName)) fail('INVALID_CUSTOMER_NAME', '请填写客户主名称');
  if (['ignore', 'reject'].includes(plan.mode) && !plan.reason) fail('ARCHIVE_REASON_REQUIRED', '请填写忽略或拒绝原因');
  if (plan.reason.length > 1000 || plan.remark.length > 1000 || plan.displayName.length > 200) fail('INVALID_ARCHIVE_INPUT', '填写内容过长');
  if (payload.newAlias && ['create', 'link'].includes(plan.mode)) {
    plan.newAlias = { name: clean(payload.newAlias.name), salesChannel: clean(payload.newAlias.salesChannel), sourceType: 'order' };
    if (!normalizeName(plan.newAlias.name) || plan.customerAliasId) fail('INVALID_ALIAS', '新增别名必须填写名称，且不能同时选择已有别名');
  }
  if (payload.newRecipient && ['create', 'link'].includes(plan.mode)) {
    plan.newRecipient = { label: clean(payload.newRecipient.label), consignee: clean(payload.newRecipient.consignee), phone: clean(payload.newRecipient.phone), address: clean(payload.newRecipient.address), sourceType: 'order' };
    const normalized = recipientData(plan.newRecipient);
    if (!normalized.normalizedConsignee || !normalized.normalizedPhone || !normalized.normalizedAddress || plan.recipientProfileId) fail('INVALID_RECIPIENT', '新增收货档案必须完整，且不能同时选择已有档案');
  }
  if (plan.mode === 'create' && (plan.customerAliasId || plan.recipientProfileId)) fail('INVALID_ARCHIVE_INPUT', '新客户不能选择其它客户的资料');
  return plan;
}
function requestResult(row) {
  return { requestId: row.requestId, status: row.status, next: row.next, total: row.plan.members.length, results: row.results, customerId: row.target?.customerId || null };
}
function createResolver(repository) {
  const { getDocById } = repository;
  return async function resolve(payload, actor) {
    const id = requestId(payload.requestId), key = digest(['archive', actor.id, id]);
    let request = await getDocById(REQUESTS, key);
    const plan = payload.resume === true ? null : parsePlan(payload);
    if (payload.resume === true && !request) fail('ARCHIVE_REQUEST_NOT_FOUND', '没有找到可恢复的归档请求');
    if (request && plan && request.payloadHash !== digest(plan)) fail('IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能用于不同处理内容');
    if (!request) request = await transaction(repository, async tx => {
      const existing = await getDocById(REQUESTS, key, tx);
      if (existing) {
        if (existing.payloadHash !== digest(plan)) fail('IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能用于不同处理内容');
        return existing;
      }
      const data = { action: 'resolveLinkCandidate', requestId: id, actorId: actor.id, plan, payloadHash: digest(plan), next: 0, results: [], status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await tx.collection(REQUESTS).doc(key).set({ data }); return { _id: key, ...data };
    });
    // One call advances at most ten single-order transactions. Progress survives timeouts/restarts.
    for (let i = 0; i < 10 && request.status !== 'completed'; i++) {
      request = await transaction(repository, async tx => {
        const current = await getDocById(REQUESTS, key, tx);
        if (current.status === 'completed') return current;
        const selection = current.plan.members[current.next];
        const member = await getDocById(MEMBERS, selection.memberId, tx);
        const order = member ? await getDocById('orders', member.orderId, tx) : null;
        const candidate = await getDocById(CANDIDATES, current.plan.candidateId, tx);
        let result, target = current.target;
        // Validate all preconditions before any business writes, including target creation.
        try {
          if (!member || member.candidateId !== current.plan.candidateId || member.status !== 'pending' || member.revision !== selection.revision) fail('ARCHIVE_MEMBER_CHANGED', '订单归档状态已变更');
          // Recommendations belong to the identity group. Members scanned in earlier batches
          // can retain older evidence; validate the reviewed group plus the member/order below.
          if (!candidate || candidate.evidenceVersion !== current.plan.evidenceVersion) fail('ARCHIVE_EVIDENCE_CHANGED', '推荐证据已更新，请刷新待归档列表并重新确认');
          if (!eligible(order) || digest(order) !== member.orderVersion || candidateId(order) !== member.candidateId) fail('ARCHIVE_ORDER_CHANGED', '订单已变更或已关联，请重新扫描');
          if (current.plan.mode === 'reject' && !candidate.matches.some(row => row.customerId === current.plan.customerId)) fail('ARCHIVE_RECOMMENDATION_CHANGED', '该客户已不在推荐结果中');
        } catch (error) {
          if (!(error instanceof CustomerError)) throw error;
          result = { memberId: selection.memberId, orderId: member?.orderId || '', status: 'conflict', code: error.code };
        }
        if (!result && ['create', 'link'].includes(current.plan.mode)) {
          try { target = await archiveTarget(repository, tx, { ...current, _id: key }, actor); }
          catch (error) {
            if (!(error instanceof CustomerError) || error.code === 'CUSTOMER_WRITE_CONFLICT') throw error;
            // archiveTarget validates all client references before making any writes.
            result = { memberId: selection.memberId, orderId: member.orderId, status: 'conflict', code: error.code };
          }
        }
        if (!result) {
          const now = new Date().toISOString();
          let updatedMember = { ...member, evidenceVersion: candidate.evidenceVersion,
            rejectedCustomerIds: member.evidenceVersion === candidate.evidenceVersion ? (member.rejectedCustomerIds || []) : [],
            revision: member.revision + 1, resolvedBy: actor.id, resolvedAt: now };
          if (['create', 'link'].includes(current.plan.mode)) {
            await tx.collection('orders').doc(order._id).update({ data: { customerId: target.customerId,
              customerAliasId: target.customerAliasId || '', recipientProfileId: target.recipientProfileId || '',
              customerLinkStatus: 'linked', customerLinkedAt: now, customerLinkedBy: actor.id,
            } });
            updatedMember = { ...updatedMember, status: 'accepted', resolvedCustomerId: target.customerId };
          } else if (current.plan.mode === 'ignore') {
            await tx.collection('orders').doc(order._id).update({ data: { customerLinkStatus: 'ignored', customerLinkIgnoreReason: current.plan.reason, customerLinkedAt: now, customerLinkedBy: actor.id } });
            updatedMember = { ...updatedMember, status: 'ignored', reason: current.plan.reason };
          } else {
            updatedMember.rejectedCustomerIds = [...new Set([...updatedMember.rejectedCustomerIds, current.plan.customerId])];
          }
          await replaceMember(repository, tx, member, updatedMember);
          await tx.collection('customer_operation_audits').doc(digest([key, selection.memberId])).set({ data: {
            action: `archive_${current.plan.mode}`, actorId: actor.id, objectId: order._id, customerId: target?.customerId || current.plan.customerId,
            candidateId: candidate._id, memberId: member._id, evidenceVersion: candidate.evidenceVersion,
            reason: current.plan.reason, createdAt: now, changedFields: current.plan.mode === 'reject' ? ['rejectedCustomerIds'] : ['customerLinkStatus', 'customerId'],
          } });
          result = { memberId: member._id, orderId: order._id, status: current.plan.mode === 'reject' ? 'rejected' : updatedMember.status, customerId: target?.customerId || null };
        }
        const next = current.next + 1;
        const data = { next, results: [...current.results, result], status: next === current.plan.members.length ? 'completed' : 'running', updatedAt: new Date().toISOString(), ...(target ? { target } : {}) };
        await tx.collection(REQUESTS).doc(key).update({ data }); return { ...current, ...data };
      });
    }
    return { success: true, data: requestResult(request) };
  };
}
module.exports = { createResolver, parsePlan };
