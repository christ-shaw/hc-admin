const { createHash } = require('node:crypto');
const { clean, normalizeName, NORMALIZATION_VERSION } = require('./normalizers');
const { aliasData, recipientData } = require('./records');
const { fail } = require('./errors');
const { bumpIdentityRevision } = require('./identityRevision');
const { recordAudit } = require('./audit');
const WRITE_ACTIONS = ['create', 'update', 'enable', 'disable', 'createAlias', 'updateAlias', 'disableAlias', 'createRecipient', 'updateRecipient', 'disableRecipient'];
const INPUT_FIELDS = ['customerId', '_id', 'aliasId', 'recipientId', 'displayName', 'remark', 'name', 'salesChannel', 'sourceType', 'enabled', 'label', 'consignee', 'phone', 'address'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestData(payload) {
  return Object.fromEntries(INPUT_FIELDS.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
}
function conflict(error) {
  return error.code === 'CUSTOMER_WRITE_CONFLICT' || error.errCode === -502001
    || /TRANSACTION_CONFLICT|transaction.*conflict|write conflict/i.test(error.message || '');
}
function createWriter(repository) {
  const { db, getDocById, fetchAll } = repository;
  return async function write(action, payload, actor) {
    if (!WRITE_ACTIONS.includes(action)) fail('ACTION_NOT_ALLOWED', '不支持此写入操作');
    const requestId = clean(payload.requestId);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) fail('REQUEST_ID_REQUIRED', '保存操作需要有效的请求 ID，请刷新页面后重试');
    const requestKey = hash([actor.id, requestId]);
    const payloadHash = hash([action, requestData(payload)]);
    const replay = record => {
      if (record.payloadHash !== payloadHash) fail('IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能用于不同操作或内容');
      return record.result;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      // Replays are valid even if the object has subsequently changed or been disabled.
      const previous = await getDocById('customer_write_requests', requestKey);
      if (previous) return replay(previous);
      const isAlias = action.endsWith('Alias');
      const isRecipient = action.endsWith('Recipient');
      const isCreate = action.startsWith('create');
      const collection = isAlias ? 'customer_aliases' : isRecipient ? 'customer_recipient_profiles' : 'customers';
      const objectId = isCreate ? hash([requestKey, collection]) : clean((isAlias ? payload.aliasId : isRecipient ? payload.recipientId : payload.customerId) || payload._id);
      const existing = isCreate ? null : await getDocById(collection, objectId);
      if (!isCreate && !existing) fail('CUSTOMER_OBJECT_NOT_FOUND', '要修改的客户资料不存在');
      const customerId = action === 'create' ? objectId : (isAlias || isRecipient) ? (isCreate ? clean(payload.customerId) : existing.customerId) : objectId;
      const parent = action === 'create' ? null : await getDocById('customers', customerId);
      if (action !== 'create' && !parent) fail('CUSTOMER_NOT_FOUND', '客户不存在');
      if (parent && (parent.status === 'merged' || parent.mergedIntoCustomerId)) fail('CUSTOMER_UNAVAILABLE', '已合并客户不能编辑，请选择最终客户');
      if ((isAlias || isRecipient) && parent.status !== 'active') fail('CUSTOMER_UNAVAILABLE', '请先启用客户，再维护其别名或收货档案');
      // Parent revision is read BEFORE the aliases. Every writer increments it in the transaction,
      // including edits/disables. A stale alias scan can therefore never commit.
      const aliases = (isAlias || action === 'create') ? await fetchAll('customer_aliases', { customerId }) : [];
      const time = new Date().toISOString();
      const updated = { updatedAt: time, updatedBy: actor.id };
      const created = { createdAt: time, createdBy: actor.id, ...updated };
      let patch;
      if (isAlias) {
        patch = action === 'disableAlias' ? { enabled: false } : aliasData({ ...existing, ...payload });
        if (action !== 'disableAlias' && !patch.normalizedName) fail('INVALID_ALIAS', '别名不能为空或仅包含分隔符');
        if (patch.enabled !== false && aliases.some(row => row._id !== objectId && row.enabled !== false
          && normalizeName(row.name) === patch.normalizedName && clean(row.salesChannel) === patch.salesChannel)) fail('DUPLICATE_ALIAS', '该客户在相同渠道下已存在此别名');
      } else if (isRecipient) {
        patch = action === 'disableRecipient' ? { enabled: false } : recipientData({ ...existing, ...payload });
        if (action !== 'disableRecipient' && (!patch.normalizedConsignee || !patch.normalizedPhone || !patch.normalizedAddress)) fail('INVALID_RECIPIENT', '收货人、电话和地址不能为空');
      } else if (action === 'enable' || action === 'disable') {
        patch = { status: action === 'enable' ? 'active' : 'disabled' };
      } else {
        const displayName = clean(payload.displayName === undefined ? existing?.displayName : payload.displayName);
        if (!normalizeName(displayName)) fail('INVALID_CUSTOMER_NAME', '客户主名称不能为空或仅包含分隔符');
        patch = { displayName, normalizedDisplayName: normalizeName(displayName), normalizationVersion: NORMALIZATION_VERSION,
          remark: clean(payload.remark === undefined ? existing?.remark : payload.remark) };
        if (isCreate) patch.status = 'active';
      }
      const transaction = await db.startTransaction();
      try {
        const saved = await getDocById('customer_write_requests', requestKey, transaction);
        if (saved) { const result = replay(saved); await transaction.rollback(); return result; }
        const currentParent = await getDocById('customers', customerId, transaction);
        if (action === 'create' ? currentParent !== null : !currentParent || (currentParent.writeRevision || 0) !== (parent.writeRevision || 0)) {
          fail('CUSTOMER_WRITE_CONFLICT', '客户资料已变更，请重试');
        }
        if (!isCreate) {
          const currentObject = await getDocById(collection, objectId, transaction);
          if (hash(currentObject) !== hash(existing)) fail('CUSTOMER_WRITE_CONFLICT', '客户资料已变更，请重试');
        }
        await bumpIdentityRevision(repository, transaction);
        const target = transaction.collection(collection).doc(objectId);
        if (isCreate) await target.set({ data: { ...patch, ...(isAlias || isRecipient ? { customerId } : { writeRevision: 1 }),
          ...(isRecipient ? { useCount: 0, lastUsedAt: '' } : {}), ...created } });
        else await target.update({ data: { ...patch, ...updated } });
        if (action !== 'create') await transaction.collection('customers').doc(customerId).update({ data: {
          writeRevision: (currentParent.writeRevision || 0) + 1, ...updated,
        } });
        const result = { success: true, ...(isCreate ? { data: { _id: objectId } } : {}) };
        if (action === 'create') {
          const aliasId = hash([requestKey, 'primaryAlias']);
          await transaction.collection('customer_aliases').doc(aliasId).set({ data: {
            customerId, ...aliasData({ name: patch.displayName, remark: '创建主档案时生成' }), ...created,
          } });
          result.data.primaryAliasId = aliasId;
        }
        await recordAudit(transaction, requestKey, { action, actorId: actor.id, objectId, customerId, changedFields: Object.keys(patch), time });
        await transaction.collection('customer_write_requests').doc(requestKey).set({ data: { payloadHash, result, actorId: actor.id, createdAt: time } });
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback().catch(() => {});
        if (conflict(error)) {
          if (attempt < 3) continue;
          fail('CUSTOMER_WRITE_CONFLICT', '客户资料正在被修改，请使用原请求重试');
        }
        throw error;
      }
    }
  };
}
module.exports = { createWriter, WRITE_ACTIONS };
