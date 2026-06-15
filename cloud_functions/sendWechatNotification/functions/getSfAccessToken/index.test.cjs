const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const FUNCTION_PATH = './index.js';

function createMockCloud(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  const calls = {
    init: [],
    collections: [],
    updates: [],
    adds: [],
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
  const originalClientCode = process.env.SF_CLIENT_CODE;
  const originalSandboxCheckWord = process.env.SF_SANDBOX_CHECK_WORD;
  const functionFullPath = require.resolve(FUNCTION_PATH);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return mockCloud.cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  global.fetch = fetchImpl;
  console.error = () => {};

  if (Object.prototype.hasOwnProperty.call(env, 'SF_CLIENT_CODE')) {
    process.env.SF_CLIENT_CODE = env.SF_CLIENT_CODE;
  } else {
    delete process.env.SF_CLIENT_CODE;
  }

  if (Object.prototype.hasOwnProperty.call(env, 'SF_SANDBOX_CHECK_WORD')) {
    process.env.SF_SANDBOX_CHECK_WORD = env.SF_SANDBOX_CHECK_WORD;
  } else {
    delete process.env.SF_SANDBOX_CHECK_WORD;
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

    if (originalClientCode === undefined) delete process.env.SF_CLIENT_CODE;
    else process.env.SF_CLIENT_CODE = originalClientCode;

    if (originalSandboxCheckWord === undefined) delete process.env.SF_SANDBOX_CHECK_WORD;
    else process.env.SF_SANDBOX_CHECK_WORD = originalSandboxCheckWord;
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
    assert.equal(result.accessToken, cachedToken);
    assert.equal(result.accessTokenMasked, 'cached***abcdef');
    assert.equal(mockCloud.calls.updates.length, 0);
    assert.equal(mockCloud.calls.adds.length, 0);
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
    assert.equal(result.accessToken, 'new-token-abcdef');
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

test('adds token cache document when it does not exist', async () => {
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

    assert.equal(result.success, true);
    assert.equal(result.cached, false);
    assert.equal(mockCloud.calls.adds.length, 1);
    assert.equal(mockCloud.docs.get('sandbox').accessToken, 'created-token-abcdef');
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
