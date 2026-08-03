export type SfPrintEnv = 'sandbox' | 'production';

export interface SfPrinter {
  index: number;
  name: string;
}

export interface SfSdkResult {
  code: number;
  msg?: string;
  requestID?: string;
  apiResultCode?: string;
  downloadUrl?: string;
  printers?: SfPrinter[];
}

export interface SfPluginPrintData {
  requestID: string;
  accessToken: string;
  templateCode: string;
  customTemplateCode?: string;
  version: string;
  documents: Array<{ masterWaybillNo: string; remark: string }>;
}

interface SfPrintInstance {
  getPrinters(callback: (result: SfSdkResult) => void): void;
  setPrinter(name: string): void;
  print(
    data: SfPluginPrintData,
    callback: (result: SfSdkResult) => void,
    options: { lodopFn: 'PRINT' | 'PREVIEW'; allPreview?: boolean },
  ): void;
}

interface SfPrintConstructor {
  new(options: {
    partnerID: string;
    env: 'pro' | 'sbox';
    notips: boolean;
    callback: (result: SfSdkResult) => void;
  }): SfPrintInstance;
}

const SDK_PATH = '/vendor/sf/SCPPrint.js';
let scriptPromise: Promise<void> | null = null;
let instancePromise: Promise<{ instance: SfPrintInstance; initResult: SfSdkResult }> | null = null;
let instanceKey = '';

function normalizeResult(value: Partial<SfSdkResult> | null | undefined): SfSdkResult {
  return {
    ...value,
    code: Number(value?.code ?? 0),
    msg: String(value?.msg || ''),
  };
}

function loadSdkScript(): Promise<void> {
  const sdkWindow = window as Window & { SCPPrint?: SfPrintConstructor };
  if (sdkWindow.SCPPrint) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const loading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_PATH}"]`);
    const script = existing || document.createElement('script');
    const handleLoad = () => sdkWindow.SCPPrint
      ? resolve()
      : reject(new Error('顺丰云打印 SDK 已加载，但未找到 SCPPrint'));
    const handleError = () => reject(new Error('顺丰云打印 SDK 加载失败'));
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    if (!existing) {
      script.src = SDK_PATH;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch(error => {
    scriptPromise = null;
    throw error;
  });
  scriptPromise = loading;
  return loading;
}

export async function getSfPrintPlugin(
  partnerID: string,
  env: SfPrintEnv,
): Promise<{ instance: SfPrintInstance; initResult: SfSdkResult }> {
  const key = `${env}:${partnerID}`;
  if (instancePromise) {
    if (instanceKey !== key) {
      throw new Error('顺丰打印环境已变化，请刷新页面后再使用插件打印');
    }
    return instancePromise;
  }

  instanceKey = key;
  const initializing = (async () => {
    await loadSdkScript();
    const Constructor = (window as Window & { SCPPrint?: SfPrintConstructor }).SCPPrint;
    if (!Constructor) throw new Error('顺丰云打印 SDK 初始化失败');

    return new Promise<{ instance: SfPrintInstance; initResult: SfSdkResult }>(resolve => {
      let instance: SfPrintInstance;
      instance = new Constructor({
        partnerID,
        env: env === 'production' ? 'pro' : 'sbox',
        notips: true,
        callback: result => resolve({ instance, initResult: normalizeResult(result) }),
      });
    });
  })().catch(error => {
    instancePromise = null;
    instanceKey = '';
    throw error;
  });
  instancePromise = initializing;
  return initializing;
}

export function getSfPrinters(instance: SfPrintInstance): Promise<SfSdkResult> {
  return new Promise(resolve => instance.getPrinters(result => resolve(normalizeResult(result))));
}

export function executeSfPluginPrint(
  instance: SfPrintInstance,
  data: SfPluginPrintData,
  operation: 'print' | 'preview',
): Promise<SfSdkResult> {
  return new Promise(resolve => {
    instance.print(
      { ...data, documents: data.documents.map(document => ({ ...document })) },
      result => resolve(normalizeResult(result)),
      operation === 'preview'
        ? { lodopFn: 'PREVIEW', allPreview: true }
        : { lodopFn: 'PRINT' },
    );
  });
}

export function setSfPrinter(instance: SfPrintInstance, printerName: string) {
  instance.setPrinter(printerName);
}

export function isTrustedSfDownloadUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname === 'scp-tcdn.sf-express.com';
  } catch {
    return false;
  }
}

export function detectSfPrintPlatform(): 'windows' | 'macos' | 'other' {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = [
    navigatorWithUserAgentData.userAgentData?.platform,
    navigator.platform,
    navigator.userAgent,
  ].filter(Boolean).join(' ').toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  return 'other';
}
