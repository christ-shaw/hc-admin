const https = require('node:https');
const { fail, normalizeDetection } = require('./detection');

function configuration(env = process.env) {
  if (!env.PHONE_DETECTOR_URL || !env.PHONE_DETECTOR_TOKEN) {
    fail('DETECTOR_NOT_CONFIGURED', '手机识别服务尚未配置，请联系管理员');
  }
  let url;
  try { url = new URL(env.PHONE_DETECTOR_URL); } catch { fail('DETECTOR_NOT_CONFIGURED', '手机识别服务地址配置错误'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('DETECTOR_NOT_CONFIGURED', '手机识别服务必须使用 HTTPS');
  }
  const threshold = Number(env.PHONE_DETECTOR_THRESHOLD || '0.45');
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) fail('DETECTOR_NOT_CONFIGURED', '手机识别阈值配置错误');
  return { url, token: env.PHONE_DETECTOR_TOKEN, threshold };
}

function postJson(config, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const request = https.request(config.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: `Bearer ${config.token}` },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        request.destroy();
        return reject(Object.assign(new Error('识别服务暂时不可用'), { code: 'DETECTOR_UNAVAILABLE', public: true }));
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 512 * 1024) {
          reject(Object.assign(new Error('识别服务返回数据过大'), { code: 'INVALID_DETECTION', public: true }));
          request.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('识别服务返回了无效数据'), { code: 'INVALID_DETECTION', public: true })); }
      });
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('识别超时，请稍后重试'), { code: 'DETECTOR_TIMEOUT', public: true })), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(data);
  });
}

function createDetector(cloud, config) {
  return async (fileID, timeoutMs) => {
    const startedAt = Date.now();
    const { fileContent } = await cloud.downloadFile({ fileID });
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) fail('DETECTOR_TIMEOUT', '照片下载超时，请重试');
    if (!Buffer.isBuffer(fileContent) || !fileContent.length || fileContent.length > 10 * 1024 * 1024) {
      fail('INVALID_IMAGE', '照片无法读取或超过 10MB');
    }
    const response = await postJson(config, { imageBase64: fileContent.toString('base64'), threshold: config.threshold }, remainingMs);
    return normalizeDetection(response, config.threshold);
  };
}

module.exports = { configuration, createDetector, postJson };
