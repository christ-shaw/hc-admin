/**
 * getSfAccessToken - 获取顺丰 OAuth2 accessToken
 *
 * 云函数环境变量：
 * SF_ENV                      sandbox | production，默认 sandbox
 * SF_CLIENT_CODE              默认顺丰客户编码
 * SF_SANDBOX_CLIENT_CODE      沙箱客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_PROD_CLIENT_CODE         生产客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_SANDBOX_CHECK_WORD       顺丰沙箱校验码
 * SF_PROD_CHECK_WORD          顺丰生产校验码
 * SF_SANDBOX_ACCESS_TOKEN_URL 沙箱 token 地址（可选）
 * SF_PROD_ACCESS_TOKEN_URL    生产 token 地址（可选）
 *
 * event.data:
 * forceRefresh?: boolean    是否强制刷新 token
 * sfEnv?: string            调用方期望环境，用于防止云函数环境配置不一致
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const TOKEN_COLLECTION = 'sf_tokens';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_URLS = {
  sandbox: 'https://sfapi-sbox.sf-express.com/oauth2/accessToken',
  production: 'https://bspgw.sf-express.com/oauth2/accessToken',
};

function trimString(value) {
  return String(value || '').trim();
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw new Error(`SF_ENV 仅支持 sandbox 或 production，当前值: ${value}`);
}

function getFirstEnv(names) {
  for (const name of names) {
    const value = trimString(process.env[name]);
    if (value) return value;
  }
  return '';
}

function getSfConfig(expectedEnv) {
  const env = normalizeSfEnv();
  if (expectedEnv && normalizeSfEnv(expectedEnv) !== env) {
    throw new Error(`顺丰环境配置不一致: 调用方期望 ${normalizeSfEnv(expectedEnv)}，getSfAccessToken 当前为 ${env}`);
  }

  const partnerID = env === 'production'
    ? getFirstEnv(['SF_PROD_CLIENT_CODE', 'SF_PRODUCTION_CLIENT_CODE', 'SF_CLIENT_CODE'])
    : getFirstEnv(['SF_SANDBOX_CLIENT_CODE', 'SF_CLIENT_CODE']);

  const secret = env === 'production'
    ? getFirstEnv(['SF_PROD_CHECK_WORD', 'SF_PRODUCTION_CHECK_WORD'])
    : getFirstEnv(['SF_SANDBOX_CHECK_WORD']);

  const accessTokenUrl = env === 'production'
    ? getFirstEnv(['SF_PROD_ACCESS_TOKEN_URL', 'SF_PRODUCTION_ACCESS_TOKEN_URL']) || DEFAULT_ACCESS_TOKEN_URLS.production
    : getFirstEnv(['SF_SANDBOX_ACCESS_TOKEN_URL']) || DEFAULT_ACCESS_TOKEN_URLS.sandbox;

  if (!partnerID) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_CLIENT_CODE 或 SF_CLIENT_CODE'
      : '缺少云函数环境变量 SF_SANDBOX_CLIENT_CODE 或 SF_CLIENT_CODE');
  }

  if (!secret) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_CHECK_WORD'
      : '缺少云函数环境变量 SF_SANDBOX_CHECK_WORD');
  }

  return {
    env,
    tokenDocId: env,
    partnerID,
    secret,
    accessTokenUrl,
  };
}

function isNotFoundError(err) {
  return err && (
    err.errCode === -1 ||
    String(err.message || '').includes('not exist') ||
    String(err.message || '').includes('does not exist')
  );
}

function maskToken(token) {
  if (!token || token.length <= 12) return token ? '***' : '';
  return `${token.slice(0, 6)}***${token.slice(-6)}`;
}

async function getCachedToken(tokenDocId) {
  try {
    const result = await db.collection(TOKEN_COLLECTION).doc(tokenDocId).get();
    return result.data || null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function saveToken(config, tokenData) {
  const collection = db.collection(TOKEN_COLLECTION);
  const updateData = {
    env: config.env,
    accessToken: tokenData.accessToken,
    expiresIn: tokenData.expiresIn,
    expiresAt: tokenData.expiresAt,
    apiResponseID: tokenData.apiResponseID || '',
    updateTime: db.serverDate(),
  };

  try {
    await collection.doc(config.tokenDocId).update({ data: updateData });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    throw new Error(`缺少 token 缓存文档 sf_tokens/${config.tokenDocId}，请先在 sf_tokens 集合中创建 _id 为 ${config.tokenDocId} 的占位文档`);
  }
}

async function requestAccessToken(config) {
  const body = new URLSearchParams({
    partnerID: config.partnerID,
    secret: config.secret,
    grantType: 'password',
  });

  const response = await fetch(config.accessTokenUrl, {
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
  const { forceRefresh = false, sfEnv } = event.data || {};

  try {
    const config = getSfConfig(sfEnv);

    if (!forceRefresh) {
      const cached = await getCachedToken(config.tokenDocId);
      if (cached && cached.accessToken && Number(cached.expiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
        return {
          success: true,
          env: config.env,
          cached: true,
          accessTokenMasked: maskToken(cached.accessToken),
          hasAccessToken: true,
          expiresIn: cached.expiresIn,
          expiresAt: cached.expiresAt,
        };
      }
    }

    const tokenData = await requestAccessToken(config);
    await saveToken(config, tokenData);

    return {
      success: true,
      env: config.env,
      cached: false,
      accessTokenMasked: maskToken(tokenData.accessToken),
      hasAccessToken: true,
      expiresIn: tokenData.expiresIn,
      expiresAt: tokenData.expiresAt,
      apiResponseID: tokenData.apiResponseID,
    };
  } catch (err) {
    console.error('获取顺丰 accessToken 失败:', err);
    return {
      success: false,
      env: (() => {
        try { return normalizeSfEnv(); } catch { return trimString(process.env.SF_ENV) || 'sandbox'; }
      })(),
      errMsg: err.message || String(err),
    };
  }
};
