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

async function getCurrentUser() {
  let identity = {};
  try {
    identity = auth.getUserInfo() || {};
  } catch (error) {
    console.warn('读取 CloudBase 当前调用用户失败:', error.message || error);
  }

  const canonicalId = firstNonEmpty([
    identity.uid,
    identity.customUserId,
    identity.openId,
  ]);
  if (!canonicalId) return null;

  return {
    id: String(canonicalId),
    uid: identity.uid || '',
    customUserId: identity.customUserId || '',
    openId: identity.openId || '',
  };
}

module.exports = {
  getCurrentUser,
};
