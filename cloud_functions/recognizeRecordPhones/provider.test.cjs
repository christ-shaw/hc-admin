const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function transport(simulate) {
  const module = { exports: {} };
  const providerPath = require.resolve('./provider');
  vm.runInNewContext(fs.readFileSync(providerPath, 'utf8'), {
    module, exports: module.exports, Buffer, URL, process, Date, setTimeout, clearTimeout,
    require: id => id === 'node:https' ? {
      request(url, options, callback) {
        const request = new EventEmitter();
        request.destroy = error => {
          if (error) queueMicrotask(() => request.emit('error', error));
          queueMicrotask(() => request.emit('close'));
        };
        request.end = body => queueMicrotask(() => simulate({ request, url, options, body, respond(status, content) {
          const response = new EventEmitter();
          response.statusCode = status;
          response.resume = () => {};
          callback(response);
          response.emit('data', Buffer.from(content));
          response.emit('end');
          request.emit('close');
        } }));
        return request;
      },
    } : require(id),
  }, { filename: providerPath });
  return module.exports;
}

const config = { url: new URL('https://detector.example/detect'), token: 'private-token', threshold: 0.45 };

test('发送图片二进制而不是任意 URL，密钥仅通过鉴权头发送', async () => {
  const provider = transport(({ options, body, respond }) => {
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    const payload = JSON.parse(body);
    assert.equal(payload.imageBase64, Buffer.from('photo-bytes').toString('base64'));
    assert.equal(payload.threshold, 0.45);
    assert.equal(payload.token, undefined);
    respond(200, JSON.stringify({ model: 'v1', detections: [] }));
  });
  const detect = provider.createDetector({ downloadFile: async () => ({ fileContent: Buffer.from('photo-bytes') }) }, config);
  assert.equal((await detect('cloud://test/photo.jpg', 100)).count, 0);
});

test('HTTP 重定向和上游错误均拒绝，不跟随重定向泄露密钥', async () => {
  for (const status of [302, 401, 429, 500]) {
    const provider = transport(({ respond }) => respond(status, 'secret upstream error'));
    await assert.rejects(provider.postJson(config, {}, 100), { code: 'DETECTOR_UNAVAILABLE' });
  }
});

test('非 JSON 返回为明确错误', async () => {
  const provider = transport(({ respond }) => respond(200, 'not-json'));
  await assert.rejects(provider.postJson(config, {}, 100), { code: 'INVALID_DETECTION' });
});

test('无响应请求在截止时间失败', async () => {
  const provider = transport(() => {});
  await assert.rejects(provider.postJson(config, {}, 5), { code: 'DETECTOR_TIMEOUT' });
});

test('过大的上游响应不会被接受', async () => {
  const provider = transport(({ respond }) => respond(200, JSON.stringify({ payload: 'x'.repeat(512 * 1024) })));
  await assert.rejects(provider.postJson(config, {}, 100), { code: 'INVALID_DETECTION' });
});

test('过大图片不发送至上游', async () => {
  const provider = transport(() => assert.fail('must not send'));
  const detect = provider.createDetector({ downloadFile: async () => ({ fileContent: Buffer.alloc(10 * 1024 * 1024 + 1) }) }, config);
  await assert.rejects(detect('cloud://test/photo.jpg', 100), { code: 'INVALID_IMAGE' });
});

test('照片下载已超过截止时间时不再发送上游请求', async () => {
  const provider = transport(() => assert.fail('must not send'));
  const detect = provider.createDetector({ downloadFile: async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { fileContent: Buffer.from('photo') };
  } }, config);
  await assert.rejects(detect('cloud://test/photo.jpg', 1), { code: 'DETECTOR_TIMEOUT' });
});
