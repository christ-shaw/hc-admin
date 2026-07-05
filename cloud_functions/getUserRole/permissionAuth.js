const tcbSdk = require('@cloudbase/node-sdk');

const tcb = tcbSdk.default || tcbSdk;
const SYSTEM_ADMIN_USERNAME = 'administrator';
const SYSTEM_ADMIN_USER_ID = '2023432132262690817';
const ENV_ID = process.env.TCB_ENV
  || process.env.SCF_NAMESPACE
  || process.env.CLOUDBASE_ENV_ID
  || 'cloud1-8gvbotkt966e5e19';

const app = tcb.init({ env: ENV_ID });
const auth = app.auth();

function firstNonEmpty(values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function unwrapUserInfo(result) {
  return result && (result.userInfo || result.data && result.data.userInfo || result.data || result) || null;
}

function getMetadata(source) {
  return source && (source.user_metadata || source.userMetadata || source.metadata || source.customUserInfo) || {};
}

function extractUsername(source) {
  if (!source || typeof source !== 'object') return '';
  const metadata = getMetadata(source);
  return String(firstNonEmpty([
    source.username,
    source.userName,
    source.loginName,
    source.name,
    metadata.username,
    metadata.userName,
    metadata.loginName,
    metadata.name,
  ]));
}

function extractNickName(source) {
  if (!source || typeof source !== 'object') return '';
  const metadata = getMetadata(source);
  return String(firstNonEmpty([
    source.nickName,
    source.nickname,
    source.displayName,
    metadata.nickName,
    metadata.nickname,
    metadata.displayName,
  ]));
}

function collectIds(source) {
  if (!source || typeof source !== 'object') return [];
  return [
    source.uid,
    source.id,
    source.userId,
    source.uuid,
    source.customUserId,
    source.openId,
    source.openid,
    source._id,
  ].filter(Boolean).map(String);
}

function getPayload(event) {
  return event && event.data || event || {};
}

function getClientUser(event) {
  const payload = getPayload(event);
  return payload.currentUser || payload.user || {};
}

async function getEndUserInfo(uid) {
  try {
    const result = uid ? await auth.getEndUserInfo(uid) : await auth.getEndUserInfo();
    return unwrapUserInfo(result);
  } catch (error) {
    console.warn('读取 CloudBase 用户资料失败:', error.message || error);
    return null;
  }
}

async function queryUserByUsername(username) {
  const queries = [
    { platform: 'USERNAME', platformId: username },
    { platform: 'CUSTOM', platformId: username },
  ];

  for (const query of queries) {
    try {
      const result = await auth.queryUserInfo(query);
      const userInfo = unwrapUserInfo(result);
      if (userInfo) return userInfo;
    } catch (_) {
      // 不同登录方式支持的 platform 不同，继续尝试下一种。
    }
  }

  return null;
}

async function getCurrentUser(event) {
  let identity = {};
  try {
    identity = auth.getUserInfo() || {};
  } catch (error) {
    console.warn('读取 CloudBase 当前调用用户失败:', error.message || error);
  }

  // 优先从 CloudBase 登录态获取身份
  let canonicalId = firstNonEmpty([
    identity.customUserId,
    identity.uid,
    identity.openId,
  ]);

  // 如果云函数登录态拿不到有效身份（anon 或空），回退到前端传来的用户信息
  if (!canonicalId || canonicalId === 'anon') {
    const clientUser = getClientUser(event);
    const clientId = firstNonEmpty([
      clientUser.id,
      clientUser.uid,
      clientUser.userId,
    ]);
    if (clientId && clientId !== 'anon') {
      canonicalId = String(clientId);
    }
  }

  if (!canonicalId || canonicalId === 'anon') return null;

  const profile = await getEndUserInfo(identity.uid && identity.uid !== 'anon' ? identity.uid : canonicalId);
  const clientUser = getClientUser(event);
  const serverUsername = extractUsername(profile) || extractUsername(identity);
  const serverNickName = extractNickName(profile) || extractNickName(identity);
  const clientUsername = extractUsername(clientUser);
  const clientNickName = extractNickName(clientUser);
  return {
    id: String(canonicalId),
    uid: identity.uid || '',
    customUserId: identity.customUserId || '',
    openId: identity.openId || '',
    username: serverUsername || clientUsername,
    nickName: serverNickName || clientNickName,
    serverUsername,
    clientUsername,
    profile,
    identity,
  };
}

async function isSystemAdministrator(user) {
  if (!user) return false;
  if (normalize(user.serverUsername) === SYSTEM_ADMIN_USERNAME) return true;
  const currentIds = [
    user.id,
    user.uid,
    user.customUserId,
    user.openId,
    ...collectIds(user.identity),
    ...collectIds(user.profile),
  ].filter(Boolean).map(String);
  if (currentIds.some(id => id === SYSTEM_ADMIN_USER_ID || normalize(id) === SYSTEM_ADMIN_USERNAME)) {
    return true;
  }

  const adminProfile = await queryUserByUsername(SYSTEM_ADMIN_USERNAME);
  if (!adminProfile) return false;

  const currentIdSet = new Set(currentIds);

  return collectIds(adminProfile).some(id => currentIdSet.has(id));
}

module.exports = {
  getCurrentUser,
  isSystemAdministrator,
};
