/* eslint-disable @typescript-eslint/no-explicit-any */
import cloudbase from '@cloudbase/js-sdk';

const ENV_ID = import.meta.env.VITE_CLOUDBASE_ENV;
const ACCESS_KEY = import.meta.env.VITE_CLOUDBASE_ACCESS_KEY;

const app = cloudbase.init({
  env: ENV_ID,
  region: 'ap-shanghai',
  accessKey: ACCESS_KEY,
  auth: { detectSessionInUrl: true },
});

export { app };
export const auth = app.auth({ persistence: 'local' });

/** 获取当前登录会话，未登录返回 null */
export async function getSession() {
  const { data } = await auth.getSession();
  return data?.session || null;
}

/** 用户名密码登录 */
export async function signIn(username: string, password: string) {
  return auth.signInWithPassword({ username, password });
}

/** 登出 */
export async function signOut() {
  return auth.signOut();
}

/** 获取当前用户信息 */
export async function getCurrentUser() {
  const { data } = await auth.getUser();
  return data?.user || null;
}

/** 获取当前操作人名称（优先昵称，其次用户名，最后用户ID） */
export async function getCurrentOperatorName(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) return '未知用户';
  return (user as any).user_metadata?.nickName
    || (user as any).user_metadata?.username
    || (user as any).id?.slice(0, 8)
    || '未知用户';
}

/** 认证过期事件名 */
export const AUTH_EXPIRED_EVENT = 'auth:expired';

/** 判断是否为认证相关错误 */
function isAuthError(err: any): boolean {
  if (!err) return false;
  // 检查错误码
  const code = String(err.code || err.resultCode || '').toUpperCase();
  if (['LOGIN_REQUIRED', 'AUTH_EXPIRED', 'TOKEN_EXPIRED', 'ACCESS_DENIED', 'UNAUTHENTICATED'].includes(code)) {
    return true;
  }
  // 检查错误消息
  const msg = String(err.message || err.msg || '').toLowerCase();
  if (msg.includes('login required') || msg.includes('auth expired') || msg.includes('token expired') || msg.includes('unauthenticated')) {
    return true;
  }
  return false;
}

/** 触发认证过期事件 */
function emitAuthExpired() {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/** 监听认证过期事件 */
export function onAuthExpired(handler: () => void) {
  window.addEventListener(AUTH_EXPIRED_EVENT, handler);
}

/** 注销认证过期事件监听 */
export function offAuthExpired(handler: () => void) {
  window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
}

/** 调用云函数（带认证错误检测） */
export async function callFunction<T = any>(name: string, data?: Record<string, unknown>): Promise<T> {
  try {
    const result = await app.callFunction({ name, data });
    const res = result.result as any;
    // 检查返回结果中的认证错误
    if (isAuthError(res)) {
      emitAuthExpired();
    }
    return res as T;
  } catch (err: any) {
    // 检查异常中的认证错误
    if (isAuthError(err)) {
      emitAuthExpired();
    }
    throw err;
  }
}

/** 上传文件到云存储 */
export async function uploadToCloudStorage(cloudPath: string, file: File): Promise<string> {
  const result = await app.uploadFile({
    cloudPath,
    filePath: file,
  });
  return result.fileID;
}

/** 获取云存储文件的临时访问链接 */
export async function getCloudFileURLs(fileIDs: string[]): Promise<Array<{ fileID: string; tempFileURL: string }>> {
  const result = await app.getTempFileURL({
    fileList: fileIDs,
  });
  return (result.fileList || []).map((item: any) => ({
    fileID: item.fileID,
    tempFileURL: item.tempFileURL || '',
  }));
}
