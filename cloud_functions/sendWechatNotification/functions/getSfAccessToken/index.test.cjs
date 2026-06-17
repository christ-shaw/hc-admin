const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const FUNCTION_PATH = './index.js';
const ENV_KEYS = [
  'SF_ENV',
  'SF_CLIENT_CODE',
  'SF_SANDBOX_CLIENT_CODE',
  'SF_PROD_CLIENT_CODE',
  'SF_PRODUCTION_CLIENT_CODE',
  'SF_SANDBOX_CHECK_WORD',
  'SF_PROD_CHECK_WORD',
  'SF_PRODUCTION_CHECK_WORD',
  'SF_SANDBOX_ACCESS_TOKEN_URL',
  'SF_PROD_ACCESS_TOKEN_URL',
  'SF_PRODUCTION_ACCESS_TOKEN_URL',
];

function createMockCloud(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  const calls = {
    init: [],
    collections: [],
    updates: [],
    adds: [],
    sets: [],
  };

  const db = {
    serverDate() {
      return { __serverDate: true };
    },
    collection(name) {
      calls.collections.push(name);

      return {
        doc(id) {
          return {
            async get() {
              if (!docs.has(id)) {
                const err = new Error('document does not exist');
                err.errCode = -1;
                throw err;
              }

              return { data: docs.get(id) };
            },
            async update({ data }) {
              calls.updates.push({ id, data });

              if (!docs.has(id)) {
                const err = new Error('document does not exist');
                err.errCode = -1;
                throw err;
              }

              docs.set(id, {
                ...docs.get(id),
                ...data,
              });
            },
            async set(data) {
              calls.sets.push({ id, data });
              docs.set(id, data);
            },
          };
        },
        async add({ data }) {
          calls.adds.push({ data });
          docs.set(data._id, data);
        },
      };
    },
  };

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init(options) {
      calls.init.push(options);
    },
    database() {
      return db;
    },
  };

  return { cloud, docs, calls };
}

async function withFunctionRuntime({ initialDocs, env, fetchImpl }, run) {
  const mockCloud = createMockCloud(initialDocs);
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const functionFullPath = require.resolve(FUNCTION_PATH);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return mockCloud.cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  global.fetch = fetchImpl;
  console.error = () => {};

  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  delete require.cache[functionFullPath];

  try {
    const mod = require(FUNCTION_PATH);
    await run(mod.main, mockCloud);
  } finally {
    delete require.cache[functionFullPath];
    Module._load = originalLoad;
    global.fetch = originalFetch;
    console.error = originalConsoleError;

    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

test('returns cached sandbox token when it is still valid', async () => {
  const cachedToken = 'cached-token-abcdef';
  const expiresAt = Date.now() + 60 * 60 * 1000;

  await withFunctionRuntime({
    initialDocs: {
      sandbox: {
        env: 'sandbox',
        accessToken: cachedToken,
        expiresIn: 7199,
        expiresAt,
      },
    },
    env: {
      SF_CLIENT_CODE: 'partner-test',
      SF_SANDBOX_CHECK_WORD: 'secret-test',
    },
    fetchImpl: async () => {
      throw new Error('fetch should not be called when cached token is valid');
    },
  }, async (main, mockCloud) => {
    const result = await main({ data: {} });

    assert.equal(result.success, true);
    assert.equal(result.env, 'sandbox');
    assert.equal(result.cached, true);
    assert.equal(result.accessToken, undefined);
    assert.equal(result.hasAccessToken, true);
    assert.equal(result.accessTokenMasked, 'cached***abcdef');
    assert.equal(mockCloud.calls.updates.length, 0);
    assert.equal(mockCloud.calls.adds.length, 0);
    assert.equal(mockCloud.calls.sets.length, 0);
  });
});

test('refreshes expired token and persists the new token', async () => {
  let capturedUrl = '';
  let capturedOptions = null;

  await withFunctionRuntime({
    initialDocs: {
      sandbox: {
        env: 'sandbox',
        accessToken: 'expired-token',
        expiresIn: 7199,
        expiresAt: Date.now() - 1000,
      },
    },
    env: {
      SF_CLIENT_CODE: 'partner-test',
      SF_SANDBOX_CHECK_WORD: 'secret-test',
    },
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            apiResultCode: 'A1000',
            apiErrorMsg: 'success',
            apiResponseID: 'response-1',
            accessToken: 'new-token-abcdef',
            expiresIn: 7199,
          });
        },
      };
    },
  }, async (main, mockCloud) => {
    const before = Date.now();
    const result = await main({ data: {} });

    assert.equal(result.success, true);
    assert.equal(result.cached, false);
    assert.equal(result.accessToken, undefined);
    assert.equal(result.hasAccessToken, true);
    assert.equal(result.apiResponseID, 'response-1');
    assert.equal(capturedUrl, 'https://sfapi-sbox.sf-express.com/oauth2/accessToken');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(capturedOptions.body.get('partnerID'), 'partner-test');
    assert.equal(capturedOptions.body.get('secret'), 'secret-test');
    assert.equal(capturedOptions.body.get('grantType'), 'password');

    const saved = mockCloud.docs.get('sandbox');
    assert.equal(saved.accessToken, 'new-token-abcdef');
    assert.equal(saved.apiResponseID, 'response-1');
    assert.equal(saved.expiresIn, 7199);
    assert.ok(saved.expiresAt >= before + 7199 * 1000 - 1000);
  });
});

test('uses production token endpoint and production token cache when SF_ENV is production', async () => {
  let capturedUrl = '';
  let capturedOptions = null;

  await withFunctionRuntime({
    initialDocs: {
      production: {
        env: 'production',
        accessToken: 'expired-prod-token',
        expiresIn: 7199,
        expiresAt: Date.now() - 1000,
      },
    },
    env: {
      SF_ENV: 'production',
      SF_PROD_CLIENT_CODE: 'prod-partner',
      SF_PROD_CHECK_WORD: 'prod-secret',
    },
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            apiResultCode: 'A1000',
            apiErrorMsg: 'success',
            apiResponseID: 'prod-response-1',
            accessToken: 'prod-token-abcdef',
            expiresIn: 7199,
          });
        },
      };
    },
  }, async (main, mockCloud) => {
    const result = await main({ data: {} });

    assert.equal(result.success, true);
    assert.equal(result.env, 'production');
    assert.equal(result.cached, false);
    assert.equal(result.accessToken, undefined);
    assert.equal(result.hasAccessToken, true);
    assert.equal(capturedUrl, 'https://bspgw.sf-express.com/oauth2/accessToken');
    assert.equal(capturedOptions.body.get('partnerID'), 'prod-partner');
    assert.equal(capturedOptions.body.get('secret'), 'prod-secret');
    assert.equal(mockCloud.docs.get('production').accessToken, 'prod-token-abcdef');
    assert.equal(mockCloud.docs.has('sandbox'), false);
  });
});

test('rejects when caller expected env differs from token function env', async () => {
  await withFunctionRuntime({
    initialDocs: {},
    env: {
      SF_ENV: 'sandbox',
      SF_CLIENT_CODE: 'partner-test',
      SF_SANDBOX_CHECK_WORD: 'secret-test',
    },
    fetchImpl: async () => {
      throw new Error('fetch should not be called when env is inconsistent');
    },
  }, async (main) => {
    const result = await main({ data: { forceRefresh: true, sfEnv: 'production' } });

    assert.equal(result.success, false);
    assert.equal(result.env, 'sandbox');
    assert.match(result.errMsg, /环境配置不一致/);
  });
});

test('returns a clear error when token cache document does not exist', async () => {
  await withFunctionRuntime({
    initialDocs: {},
    env: {
      SF_CLIENT_CODE: 'partner-test',
      SF_SANDBOX_CHECK_WORD: 'secret-test',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          apiResultCode: 'A1000',
          apiErrorMsg: 'success',
          apiResponseID: 'response-2',
          accessToken: 'created-token-abcdef',
          expiresIn: 7199,
        });
      },
    }),
  }, async (main, mockCloud) => {
    const result = await main({ data: { forceRefresh: true } });

    assert.equal(result.success, false);
    assert.match(result.errMsg, /sf_tokens\/sandbox/);
    assert.equal(mockCloud.calls.sets.length, 0);
    assert.equal(mockCloud.docs.has('sandbox'), false);
  });
});

test('returns a clear error when sandbox secret env var is missing', async () => {
  await withFunctionRuntime({
    initialDocs: {},
    env: {
      SF_CLIENT_CODE: 'partner-test',
    },
    fetchImpl: async () => {
      throw new Error('fetch should not be called when config is invalid');
    },
  }, async (main) => {
    const result = await main({ data: { forceRefresh: true } });

    assert.equal(result.success, false);
    assert.equal(result.env, 'sandbox');
    assert.match(result.errMsg, /SF_SANDBOX_CHECK_WORD/);
  });
});
