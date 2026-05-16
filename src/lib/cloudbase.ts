/* eslint-disable @typescript-eslint/no-explicit-any */
const ENV_ID = import.meta.env.VITE_CLOUDBASE_ENV;

let app: any = null;
let initPromise: Promise<boolean> | null = null;

/** 确保 CloudBase 已初始化，自动初始化无需登录 */
export async function ensureInit(): Promise<boolean> {
  if (app) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!ENV_ID) {
      console.error('CloudBase 环境 ID 未配置');
      return false;
    }

    try {
      const sdkModule = await import('@cloudbase/js-sdk');
      let cloudbase: any = sdkModule;
      while (cloudbase.default && typeof cloudbase.default === 'object') {
        cloudbase = cloudbase.default;
      }
      if (typeof cloudbase !== 'function' && typeof cloudbase.init !== 'function') {
        console.error('CloudBase SDK 导入异常:', sdkModule);
        return false;
      }
      app = cloudbase.init ? cloudbase.init({ env: ENV_ID }) : cloudbase({ env: ENV_ID });

      // 自动匿名登录（对用户透明）
      const auth = app.auth({ persistence: 'local' });
      const loginState = await auth.getLoginState();
      if (!loginState) {
        await auth.signInAnonymously();
        console.log('CloudBase 匿名登录完成');
      } else {
        console.log('CloudBase 已有登录状态');
      }
      return true;
    } catch (err) {
      console.error('CloudBase 初始化失败:', err);
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

/** 获取 CloudBase 实例（需先调用 ensureInit） */
export function getApp(): any {
  if (!app) {
    throw new Error('CloudBase 未初始化');
  }
  return app;
}

/** 调用云函数（自动初始化） */
export async function callFunction<T = any>(name: string, data?: Record<string, unknown>): Promise<T> {
  await ensureInit();
  const appInstance = getApp();
  const result = await appInstance.callFunction({ name, data });
  return result.result as T;
}
