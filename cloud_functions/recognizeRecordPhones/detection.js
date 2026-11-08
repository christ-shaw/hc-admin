const crypto = require('node:crypto');

function fail(code, message) {
  throw Object.assign(new Error(message), { code, public: true });
}

function photosOf(record) {
  const photos = record.phonePhotos || [];
  if (!Array.isArray(photos) || photos.some(p => typeof p !== 'string' || !/^cloud:\/\/[^/]+\/.+/.test(p))) {
    fail('INVALID_PHOTOS', '手机照片必须是云存储文件 ID');
  }
  const unique = [...new Set(photos)];
  if (!unique.length) fail('NO_PHOTOS', '该记录没有手机照片');
  if (unique.length > 9) fail('TOO_MANY_PHOTOS', '单次最多识别 9 张手机照片');
  return unique;
}

function sourceKey(photos, mode) {
  return crypto.createHash('sha256').update(JSON.stringify({ photos, mode })).digest('hex');
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection);
}

// 数量由服务端从有效目标框计算，不信任上游传入的 count。
function normalizeDetection(response, threshold) {
  if (!response || !Array.isArray(response.detections) || response.detections.length > 1000
    || typeof response.model !== 'string' || !response.model.trim() || response.model.length > 120) {
    fail('INVALID_DETECTION', '识别服务返回了无效结果');
  }
  const candidates = [];
  for (const item of response.detections) {
    if (!item || typeof item.label !== 'string' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1 || !Array.isArray(item.box)
      || item.box.length !== 4 || item.box.some(n => !Number.isFinite(n) || n < 0 || n > 1)
      || item.box[0] >= item.box[2] || item.box[1] >= item.box[3]) {
      fail('INVALID_DETECTION', '识别服务返回了无效目标框');
    }
    if (['phone', 'cell phone', 'mobile phone', 'smartphone', '手机'].includes(item.label.toLowerCase())
      && item.confidence >= threshold) candidates.push({ confidence: item.confidence, box: item.box });
  }
  const detections = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (!detections.some(kept => iou(candidate.box, kept.box) > 0.7)) detections.push(candidate);
  }
  return { model: response.model, count: detections.length, detections };
}

function summarize(images, mode, record) {
  const complete = images.length > 0 && images.every(image => image.status === 'succeeded');
  const totalCount = complete && (images.length === 1 || mode === 'distinct')
    ? images.reduce((total, image) => total + image.count, 0) : null;
  const models = record.phoneModels;
  const expectedCount = Array.isArray(models) && models.length && models.every(m => Number.isInteger(m.quantity) && m.quantity >= 0)
    ? models.reduce((total, model) => total + model.quantity, 0) : null;
  return {
    totalCount, expectedCount,
    difference: totalCount !== null && expectedCount !== null ? totalCount - expectedCount : null,
    needsReview: true,
  };
}

module.exports = { fail, photosOf, sourceKey, normalizeDetection, summarize };
