const { randomUUID } = require('node:crypto');
const { fail, photosOf, sourceKey, summarize } = require('./detection');

const LEASE_MS = 150000;

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('照片识别超时，请重试'), { code: 'DETECTOR_TIMEOUT', public: true })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function createService({ db, authorize, detector, now = Date.now }) {
  async function transaction(work) {
    const tx = await db.startTransaction();
    try { const result = await work(tx); await tx.commit(); return result; }
    catch (error) { try { await tx.rollback(); } catch {} throw error; }
  }
  const replace = value => db.command.set(value);

  return async function recognize(event) {
    const payload = event?.data || event || {};
    const { type, recordId, action = 'recognize', mode = 'distinct', force = false } = payload;
    if (!['inbound', 'outbound'].includes(type) || typeof recordId !== 'string' || !recordId.trim()
      || recordId.length > 128 || !['get', 'recognize'].includes(action)
      || !['separate', 'distinct'].includes(mode) || typeof force !== 'boolean') {
      return { success: false, code: 'INVALID_ARGUMENT', errMsg: '记录类型、ID 或识别参数无效' };
    }
    let requestId;
    const collection = `${type}_records`;
    try {
      const auth = await authorize(`${type}:${action === 'get' ? 'read' : 'update'}`);
      if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };
      const getRecord = async store => {
        const { data } = await store.collection(collection).doc(recordId).get();
        if (!data) fail('RECORD_NOT_FOUND', '记录不存在');
        return data;
      };
      if (action === 'get') {
        const record = await getRecord(db);
        const state = record.phoneDetection || null;
        let stale = false;
        if (state) {
          try { stale = sourceKey(photosOf(record), state.mode) !== state.sourceKey; } catch { stale = true; }
        }
        const result = state ? { ...state, ...summarize(state.images || [], state.mode, record), stale } : null;
        if (result && stale) { result.totalCount = null; result.difference = null; }
        return { success: true, data: result };
      }
      // 配置错误不抢占任务，也不覆盖之前的识别结果。
      const detect = detector();
      requestId = randomUUID();
      const claim = await transaction(async tx => {
        const record = await getRecord(tx);
        const photos = photosOf(record);
        const key = sourceKey(photos, mode);
        const previous = record.phoneDetection;
        if (previous?.status === 'processing' && previous.leaseUntil > now()) {
          fail('RECOGNITION_BUSY', '该记录正在识别，请稍后查询');
        }
        if (!force && previous?.sourceKey === key && previous.status === 'succeeded') {
          return { cached: { ...previous, ...summarize(previous.images, mode, record) } };
        }
        const state = { status: 'processing', requestId, sourceKey: key, mode, startedAt: new Date(now()).toISOString(), leaseUntil: now() + LEASE_MS, images: [], totalCount: null, needsReview: true };
        await tx.collection(collection).doc(recordId).update({ data: { phoneDetection: replace(state) } });
        return { state, photos };
      });
      if (claim.cached) return { success: true, cached: true, data: claim.cached };
      const images = [];
      const deadline = now() + 100000;
      for (const fileID of claim.photos) {
        try {
          if (now() >= deadline) fail('DETECTOR_TIMEOUT', '识别超时，请重试');
          const timeoutMs = Math.min(15000, deadline - now());
          const result = await within(detect(fileID, timeoutMs), timeoutMs);
          images.push({ fileID, status: 'succeeded', ...result });
        } catch (error) {
          images.push({ fileID, status: 'failed', count: null, code: error.public ? error.code : 'DETECTION_FAILED', errMsg: error.public ? error.message : '该照片识别失败，请重试' });
        }
      }
      const result = await transaction(async tx => {
        const record = await getRecord(tx);
        if (record.phoneDetection?.requestId !== requestId) fail('RECOGNITION_SUPERSEDED', '识别任务已被更新，请重新查询');
        let key;
        try { key = sourceKey(photosOf(record), mode); } catch { key = null; }
        const stale = key !== claim.state.sourceKey;
        const succeeded = images.filter(image => image.status === 'succeeded').length;
        const state = {
          ...claim.state, images, ...summarize(images, mode, record),
          status: stale ? 'stale' : succeeded === images.length ? 'succeeded' : succeeded ? 'partial' : 'failed',
          stale, leaseUntil: 0, completedAt: new Date(now()).toISOString(),
        };
        if (stale) { state.totalCount = null; state.difference = null; }
        await tx.collection(collection).doc(recordId).update({ data: { phoneDetection: replace(state) } });
        return state;
      });
      return { success: true, data: result };
    } catch (error) {
      // 不输出照片、令牌、上游响应等信息。进程中断时租约到期即可重试。
      console.error('[recognizeRecordPhones]', error.public ? error.code : 'RECOGNITION_FAILED');
      return { success: false, code: error.public ? error.code : 'RECOGNITION_FAILED', errMsg: error.public ? error.message : '手机识别失败，请稍后重试' };
    }
  };
}

module.exports = { createService };
