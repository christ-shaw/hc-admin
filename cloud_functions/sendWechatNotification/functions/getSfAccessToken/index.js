/**
 * getSfAccessToken - 获取顺丰沙箱 OAuth2 accessToken
 *
 * 当前仅支持沙箱环境：
 * POST https://sfapi-sbox.sf-express.com/oauth2/accessToken
 *
 * 云函数环境变量：
 * SF_CLIENT_CODE            顺丰客户编码
 * SF_SANDBOX_CHECK_WORD     顺丰沙箱校验码
 *
 * event.data:
 * forceRefresh?: boolean    是否强制刷新 token
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const SF_ENV = 'sandbox';
const TOKEN_DOC_ID = 'sandbox';
const TOKEN_COLLECTION = 'sf_tokens';
const ACCESS_TOKEN_URL = 'https://sfapi-sbox.sf-express.com/oauth2/accessToken';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function isNotFoundError(err) {
  return err && (
    err.errCode === -1 ||
    String(err.message || '').includes('not exist') ||
    String(err.message || '').includes('does not exist')
  );
}

function getConfig() {
  const partnerID = process.env.SF_CLIENT_CODE;
  const secret = process.env.SF_SANDBOX_CHECK_WORD;

  if (!partnerID) {
    throw new Error('缺少云函数环境变量 SF_CLIENT_CODE');
  }

  if (!secret) {
    throw new Error('缺少云函数环境变量 SF_SANDBOX_CHECK_WORD');
  }

  return { partnerID, secret };
}

function maskToken(token) {
  if (!token || token.length <= 12) return token ? '***' : '';
  return `${token.slice(0, 6)}***${token.slice(-6)}`;
}

async function getCachedToken() {
  try {
    const result = await db.collection(TOKEN_COLLECTION).doc(TOKEN_DOC_ID).get();
    return result.data || null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function saveToken(tokenData) {
  const collection = db.collection(TOKEN_COLLECTION);
  const updateData = {
    env: SF_ENV,
    accessToken: tokenData.accessToken,
    expiresIn: tokenData.expiresIn,
    expiresAt: tokenData.expiresAt,
    apiResponseID: tokenData.apiResponseID || '',
    updateTime: db.serverDate(),
  };

  try {
    await collection.doc(TOKEN_DOC_ID).update({ data: updateData });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    await collection.add({
      data: {
        _id: TOKEN_DOC_ID,
        ...updateData,
      },
    });
  }
}

async function requestAccessToken() {
  const { partnerID, secret } = getConfig();
  const body = new URLSearchParams({
    partnerID,
    secret,
    grantType: 'password',
  });

  const response = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });

  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`顺丰 token 接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`顺丰 token 接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || text}`);
  }

  if (result.apiResultCode !== 'A1000' || !result.accessToken) {
    throw new Error(result.apiErrorMsg || `顺丰 token 获取失败: ${result.apiResultCode || 'UNKNOWN'}`);
  }

  const expiresIn = Number(result.expiresIn || 0);
  if (!expiresIn || expiresIn <= 0) {
    throw new Error('顺丰 token 返回 expiresIn 无效');
  }

  return {
    accessToken: result.accessToken,
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
    apiResponseID: result.apiResponseID || '',
  };
}

exports.main = async (event) => {
  const { forceRefresh = false } = event.data || {};

  try {
    if (!forceRefresh) {
      const cached = await getCachedToken();
      if (cached && cached.accessToken && Number(cached.expiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
        return {
          success: true,
          env: SF_ENV,
          cached: true,
          accessToken: cached.accessToken,
          accessTokenMasked: maskToken(cached.accessToken),
          expiresIn: cached.expiresIn,
          expiresAt: cached.expiresAt,
        };
      }
    }

    const tokenData = await requestAccessToken();
    await saveToken(tokenData);

    return {
      success: true,
      env: SF_ENV,
      cached: false,
      accessToken: tokenData.accessToken,
      accessTokenMasked: maskToken(tokenData.accessToken),
      expiresIn: tokenData.expiresIn,
      expiresAt: tokenData.expiresAt,
      apiResponseID: tokenData.apiResponseID,
    };
  } catch (err) {
    console.error('获取顺丰沙箱 accessToken 失败:', err);
    return {
      success: false,
      env: SF_ENV,
      errMsg: err.message || String(err),
    };
  }
};
