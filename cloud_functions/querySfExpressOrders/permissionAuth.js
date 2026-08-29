const tcbSdk = require('@cloudbase/node-sdk');

const tcb = tcbSdk.default || tcbSdk;
const ENV_ID = process.env.TCB_ENV
  || process.env.SCF_NAMESPACE
  || process.env.CLOUDBASE_ENV_ID
  || 'cloud1-8gvbotkt966e5e19';

const app = tcb.init({ env: ENV_ID });
const auth = app.auth();

function firstNonEmpty(values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function uniqueValidIds(values) {
  return Array.from(new Set(
    values
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value).trim())
      .filter(value => value && value !== 'anon')
  ));
}

async function getCurrentUser() {
  let identity = {};
  try {
    identity = auth.getUserInfo() || {};
  } catch (error) {
    console.warn('读取 CloudBase 当前调用用户失败:', error.message || error);
  }

  // user_roles 历史上可能保存 customUserId、uid 或 openId。统一权限模块以
  // customUserId 为主，因此顺丰工作台必须按同一顺序识别，并保留全部 ID 逐个查找。
  const ids = uniqueValidIds([identity.customUserId, identity.uid, identity.openId]);
  const canonicalId = firstNonEmpty(ids);
  if (!canonicalId) return null;

  return {
    id: String(canonicalId),
    ids,
    uid: identity.uid || '',
    customUserId: identity.customUserId || '',
    openId: identity.openId || '',
  };
}

module.exports = { getCurrentUser };
