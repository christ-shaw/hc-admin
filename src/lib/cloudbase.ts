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

/** 调用云函数 */
export async function callFunction<T = any>(name: string, data?: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name, data });
  return result.result as T;
}
