/**
 * getUserRole - 获取当前登录用户角色与权限
 *
 * 返回权限系统初始化状态、当前用户角色、页面权限和功能权限。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser, isSystemAdministrator } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (err) {
    console.log(`[getDoc] ${collectionName}/${id} 错误:`, JSON.stringify({ errCode: err.errCode, message: err.message }));
    if (notFound(err)) return null;
    throw err;
  }
}

async function getSystemConfig() {
  try {
    const result = await db.collection(CONFIG_COLLECTION)
      .where({ _id: CONFIG_ID })
      .limit(1)
      .get();
    return (result.data && result.data[0]) || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function findUserRole(userId) {
  try {
    const result = await db.collection(USER_ROLE_COLLECTION)
      .where({ userId })
      .limit(1)
      .get();
    return result.data && result.data[0] || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

exports.main = async (event, context) => {
  try {
    const currentUser = await getCurrentUser(event);
    if (!currentUser) {
      return {
        success: false,
        initialized: false,
        status: 'forbidden',
        code: 'LOGIN_REQUIRED',
        errMsg: '请先登录',
      };
    }

    const config = await getSystemConfig();
    const initialized = !!(config && config.initialized);

    if (!initialized) {
      const canInitialize = await isSystemAdministrator(currentUser);
      console.log('[getUserRole] 未初始化，当前用户:', JSON.stringify({
        id: currentUser.id,
        uid: currentUser.uid,
        username: currentUser.username,
        serverUsername: currentUser.serverUsername,
        clientUsername: currentUser.clientUsername,
        nickName: currentUser.nickName,
      }, null, 2), 'canInitialize:', canInitialize);
      return {
        success: true,
        initialized: false,
        status: canInitialize ? 'uninitialized' : 'forbidden',
        data: null,
        canInitialize,
      };
    }

    const userRole = await findUserRole(currentUser.id);
    console.log('[getUserRole] 查询用户角色, userId:', currentUser.id, 'uid:', currentUser.uid, '找到:', !!userRole);
    if (!userRole) {
      return {
        success: true,
        initialized: true,
        status: 'unassigned',
        data: null,
        errMsg: '当前用户未分配角色',
      };
    }

    const role = await getDoc(ROLE_COLLECTION, userRole.roleId);
    if (!role) {
      return {
        success: true,
        initialized: true,
        status: 'error',
        data: null,
        code: 'ROLE_NOT_FOUND',
        errMsg: '用户关联的角色不存在',
      };
    }

    return {
      success: true,
      initialized: true,
      status: 'ready',
      data: {
        roleId: role._id,
        roleName: role.name,
        roleCode: role.code || '',
        pagePermissions: unique(role.pagePermissions),
        actionPermissions: unique(role.actionPermissions),
      },
    };
  } catch (error) {
    console.error('获取用户权限失败:', error);
    const message = String(error && error.message || '');
    if (message.includes('not exist') || message.includes('collection')) {
      return {
        success: false,
        initialized: false,
        status: 'error',
        data: null,
        code: 'COLLECTION_NOT_EXIST',
        errMsg: '数据库集合不存在，请先在 CloudBase 控制台创建 roles、user_roles、system_config 集合',
      };
    }
    return {
      success: false,
      initialized: false,
      status: 'error',
      data: null,
      code: 'PERMISSION_LOAD_FAILED',
      errMsg: error.message || '获取用户权限失败',
    };
  }
};
