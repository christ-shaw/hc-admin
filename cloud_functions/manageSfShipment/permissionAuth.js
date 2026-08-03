const tcbSdk = require('@cloudbase/node-sdk');

const tcb = tcbSdk.default || tcbSdk;
const ENV_ID = process.env.TCB_ENV
  || process.env.SCF_NAMESPACE
  || process.env.CLOUDBASE_ENV_ID
  || 'cloud1-8gvbotkt966e5e19';

const app = tcb.init({ env: ENV_ID });
const auth = app.auth();

function uniqueIds(values) {
  return Array.from(new Set(values
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).trim())
    .filter(value => value && value !== 'anon')));
}

async function getCurrentUser() {
  let identity = {};
  try {
    identity = auth.getUserInfo() || {};
  } catch (error) {
    console.warn('读取 CloudBase 当前调用用户失败:', error.message || error);
  }

  const ids = uniqueIds([
    identity.customUserId,
    identity.uid,
    identity.openId,
  ]);
  if (ids.length === 0) return null;

  return {
    id: ids[0],
    ids,
    uid: identity.uid || '',
    customUserId: identity.customUserId || '',
    openId: identity.openId || '',
  };
}

module.exports = { getCurrentUser };
