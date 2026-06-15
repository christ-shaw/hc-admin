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

/** ========== AI 模型动态配置 ========== */

/** 可用的 AI 模型选项 */
export const AI_MODEL_OPTIONS = [
  { group: 'custom-deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { group: 'hunyuan-v3', model: 'hy3-preview', label: '混元 3.0' }
] as const;

export type AIModelConfig = typeof AI_MODEL_OPTIONS[number];

const AI_MODEL_STORAGE_KEY = 'hc_admin_ai_model';

/** 获取当前 AI 模型配置 */
export function getAIModelConfig(): AIModelConfig {
  try {
    const saved = localStorage.getItem(AI_MODEL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const match = AI_MODEL_OPTIONS.find(o => o.group === parsed.group && o.model === parsed.model);
      if (match) return match;
    }
  } catch { /* ignore */ }
  return AI_MODEL_OPTIONS[0]; // 默认 custom-deepseek / deepseek-v4-flash
}

/** 保存 AI 模型配置 */
export function setAIModelConfig(config: AIModelConfig): void {
  localStorage.setItem(AI_MODEL_STORAGE_KEY, JSON.stringify({ group: config.group, model: config.model }));
}

/** 创建当前配置的 AI 模型实例 */
export function createCurrentAIModel() {
  const config = getAIModelConfig();
  return app.ai().createModel(config.group);
}

/** 获取当前模型 ID */
export function getCurrentModelId(): string {
  return getAIModelConfig().model;
}

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
    filePath: file as unknown as string,
  });
  return result.fileID;
}

/** AI 智能解析收件人信息（姓名、电话、地址） */
export async function parseConsigneeInfo(text: string): Promise<{ name: string; phone: string; address: string } | null> {
  try {
    const res = await createCurrentAIModel().streamText({
      model: getCurrentModelId(),
      messages: [
        {
          role: 'system',
          content: '你是一个收件人信息解析助手。用户会输入一段包含收件人姓名、电话和地址的文本，你需要从中提取出姓名、电话和地址，并以JSON格式返回。格式：{"name":"姓名","phone":"电话","address":"地址"}。只返回JSON，不要返回其他内容。如果某个字段无法识别，设为空字符串。',
        },
        {
          role: 'user',
          content: text,
        },
      ],
    });

    let fullText = '';
    for await (const data of res.dataStream) {
      const content = data?.choices?.[0]?.delta?.content;
      if (content) fullText += content;
    }

    const jsonStr = fullText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object') {
      return {
        name: String(parsed.name || ''),
        phone: String(parsed.phone || ''),
        address: String(parsed.address || ''),
      };
    }
    return null;
  } catch (err: unknown) {
    console.error('[parseConsigneeInfo] AI 调用失败，完整错误:', err);
    const msg = err instanceof Error ? err.message : String(err || '');
    if (msg.includes('not found') || msg.includes('not enabled') || msg.includes('未开通')) {
      throw new Error('AI 模型未启用，请在 CloudBase 控制台开启 AI 模型服务：https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/ai');
    }
    throw new Error('智能识别失败: ' + msg);
  }
}

/** AI 智能解析公司开票信息 */
export async function parseCompanyInfo(text: string): Promise<{
  companyName: string;
  taxId: string;
  registeredAddress: string;
  contactPhone: string;
  bankName: string;
  bankAccount: string;
  bankCode: string;
} | null> {
  try {
    const res = await createCurrentAIModel().streamText({
      model: getCurrentModelId(),
      messages: [
        {
          role: 'system',
          content: '你是一个公司开票信息解析助手。用户会输入包含单位名称、纳税人识别号、注册地址、联系电话、开户行名称、银行账号、开户行行号的文本。请提取字段并只返回JSON，格式：{"companyName":"单位名称","taxId":"纳税人识别号","registeredAddress":"注册地址","contactPhone":"联系电话","bankName":"开户行名称","bankAccount":"账号","bankCode":"开户行行号"}。无法识别的字段返回空字符串，不要返回解释。',
        },
        {
          role: 'user',
          content: text,
        },
      ],
    });

    let fullText = '';
    for await (const data of res.dataStream) {
      const content = data?.choices?.[0]?.delta?.content;
      if (content) fullText += content;
    }

    const jsonStr = fullText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object') {
      return {
        companyName: String(parsed.companyName || ''),
        taxId: String(parsed.taxId || ''),
        registeredAddress: String(parsed.registeredAddress || ''),
        contactPhone: String(parsed.contactPhone || ''),
        bankName: String(parsed.bankName || ''),
        bankAccount: String(parsed.bankAccount || ''),
        bankCode: String(parsed.bankCode || ''),
      };
    }
    return null;
  } catch (err: unknown) {
    console.error('[parseCompanyInfo] AI 调用失败，完整错误:', err);
    const msg = err instanceof Error ? err.message : String(err || '');
    if (msg.includes('not found') || msg.includes('not enabled') || msg.includes('未开通')) {
      throw new Error('AI 模型未启用，请在 CloudBase 控制台开启 AI 模型服务：https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/ai');
    }
    throw new Error('智能识别失败: ' + msg);
  }
}

/** 获取云存储文件的临时访问链接 */
export async function getCloudFileURLs(fileIDs: string[]): Promise<Array<{ fileID: string; tempFileURL: string }>> {
  const validFileIDs = fileIDs.filter(Boolean);
  const uniqueFileIDs = Array.from(new Set(validFileIDs));
  if (uniqueFileIDs.length === 0) return [];

  try {
    const result = await callFunction<{
      success?: boolean;
      fileList?: Array<{ fileID: string; tempFileURL?: string }>;
    }>('getCloudFileUrls', { data: { fileIDs: uniqueFileIDs } });

    if (result.success && Array.isArray(result.fileList)) {
      const urlMap = new Map(result.fileList.map(item => [item.fileID, item.tempFileURL || '']));
      return validFileIDs.map(fileID => ({
        fileID,
        tempFileURL: urlMap.get(fileID) || '',
      }));
    }
  } catch (err) {
    console.warn('[getCloudFileURLs] 云函数获取临时链接失败，尝试前端 SDK:', err);
  }

  const result = await app.getTempFileURL({
    fileList: uniqueFileIDs,
  });
  const urlMap = new Map((result.fileList || []).map((item: any) => [item.fileID, item.tempFileURL || '']));
  return validFileIDs.map(fileID => ({
    fileID,
    tempFileURL: String(urlMap.get(fileID) || ''),
  }));
}
