import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, MessagePlugin, Select, Tag } from 'tdesign-react';
import { Download, Eye, FileText, LoaderCircle, Printer, RefreshCw } from 'lucide-react';
import type { SfExpressWorkbenchRow } from '../types';
import { callFunction } from '../lib/cloudbase';
import {
  detectSfPrintPlatform,
  executeSfPluginPrint,
  getSfPrintPlugin,
  getSfPrinters,
  isTrustedSfDownloadUrl,
  setSfPrinter,
  type SfPluginPrintData,
  type SfPrinter,
  type SfSdkResult,
  type SfPrintEnv,
} from '../utils/sfPrintPlugin';

interface BootstrapResult {
  success: boolean;
  env?: SfPrintEnv;
  sdkEnv?: 'pro' | 'sbox';
  partnerID?: string;
  pluginPrintEnabled?: boolean;
  sdkVersion?: string;
  code?: string;
  errMsg?: string;
}

interface PrepareResult extends SfPluginPrintData {
  success: boolean;
  env?: SfPrintEnv;
  sfExpressOrderId?: string;
  sourceOrderId?: string;
  waybillNo?: string;
  code?: string;
  errMsg?: string;
}

interface RecordResult {
  success: boolean;
  status?: 'succeeded' | 'previewed' | 'failed' | 'expired';
  counted?: boolean;
  duplicated?: boolean;
  code?: string;
  errMsg?: string;
}

interface SfPrintDialogProps {
  record: SfExpressWorkbenchRow | null;
  batchRecords?: SfExpressWorkbenchRow[];
  onClose: () => void;
  onPdfPrint: (record: SfExpressWorkbenchRow) => Promise<void>;
  onPluginPrinted: () => void;
}

interface BatchPrintResult {
  sourceOrderId: string;
  orderLabel: string;
  waybillNo: string;
  success: boolean;
  errMsg?: string;
}

const platform = detectSfPrintPlatform();

function resultMessage(result: SfSdkResult) {
  if (result.code === 2) return '未检测到顺丰云打印插件，请下载安装后刷新页面';
  if (result.code === 3) return '顺丰云打印插件版本过低，请升级后刷新页面';
  if (result.code === 4) return '打印组件仍在加载，请稍后重试';
  return result.msg || `打印插件返回代码 ${result.code}`;
}

function getOrderLabel(record: SfExpressWorkbenchRow) {
  return record.order.onlineOrderNumber || `序号 ${record.order.serialNumber || '-'}`;
}

export function SfPrintDialog({
  record,
  batchRecords = [],
  onClose,
  onPdfPrint,
  onPluginPrinted,
}: SfPrintDialogProps) {
  const records = useMemo(
    () => batchRecords.length > 0 ? batchRecords : record ? [record] : [],
    [batchRecords, record],
  );
  const primaryRecord = records[0] || null;
  const recordsKey = records.map(item => item.currentSfOrder?._id || item.order._id).join('|');
  const isBatch = records.length > 1;
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [bootstrapError, setBootstrapError] = useState('');
  const [pluginResult, setPluginResult] = useState<SfSdkResult | null>(null);
  const [printers, setPrinters] = useState<SfPrinter[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [initializing, setInitializing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState<'print' | 'preview' | 'pdf' | 'batch' | ''>('');
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchPrintingOrderId, setBatchPrintingOrderId] = useState('');
  const [batchResults, setBatchResults] = useState<BatchPrintResult[]>([]);

  const pluginUsable = platform === 'windows'
    && bootstrap?.pluginPrintEnabled === true
    && pluginResult?.code === 1;
  const printerOptions = useMemo(
    () => printers.map(printer => ({ label: printer.name, value: printer.name })),
    [printers],
  );

  const refreshPrinters = async (showMessage = true) => {
    if (!bootstrap?.partnerID || !bootstrap.env) return;
    setRefreshing(true);
    try {
      const { instance } = await getSfPrintPlugin(bootstrap.partnerID, bootstrap.env);
      const result = await getSfPrinters(instance);
      setPluginResult(result);
      if (result.code !== 1) throw new Error(resultMessage(result));
      const nextPrinters = result.printers || [];
      setPrinters(nextPrinters);
      const saved = localStorage.getItem(`sf.print.printer.${bootstrap.env}`) || '';
      const nextName = nextPrinters.some(item => item.name === saved)
        ? saved
        : nextPrinters[0]?.name || '';
      setPrinterName(nextName);
      if (nextName) setSfPrinter(instance, nextName);
      if (saved && saved !== nextName && showMessage) {
        MessagePlugin.warning('上次使用的打印机已不存在，请重新选择');
      }
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!primaryRecord) return;
    let active = true;
    setBootstrap(null);
    setBootstrapError('');
    setPluginResult(null);
    setPrinters([]);
    setPrinterName('');
    setBatchProgress(0);
    setBatchPrintingOrderId('');
    setBatchResults([]);

    if (platform !== 'windows') return;
    setInitializing(true);
    callFunction<BootstrapResult>('manageSfPluginPrint', { data: { action: 'bootstrap' } })
      .then(async result => {
        if (!active) return;
        if (!result.success) throw new Error(result.errMsg || '读取插件打印配置失败');
        setBootstrap(result);
        if (!result.pluginPrintEnabled || !result.partnerID || !result.env) return;
        const sdk = await getSfPrintPlugin(result.partnerID, result.env);
        if (!active) return;
        setPluginResult(sdk.initResult);
        if (sdk.initResult.code === 1) {
          const printerResult = await getSfPrinters(sdk.instance);
          if (!active) return;
          setPluginResult(printerResult.code === 1 ? sdk.initResult : printerResult);
          const nextPrinters = printerResult.printers || [];
          setPrinters(nextPrinters);
          const saved = localStorage.getItem(`sf.print.printer.${result.env}`) || '';
          const nextName = nextPrinters.some(item => item.name === saved)
            ? saved
            : nextPrinters[0]?.name || '';
          setPrinterName(nextName);
          if (nextName) setSfPrinter(sdk.instance, nextName);
        }
      })
      .catch(error => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setBootstrapError(message);
        MessagePlugin.error(message);
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, [recordsKey]);

  const handlePrinterChange = async (value: unknown) => {
    if (!bootstrap?.partnerID || !bootstrap.env) return;
    const nextName = String(value);
    const { instance } = await getSfPrintPlugin(bootstrap.partnerID, bootstrap.env);
    setSfPrinter(instance, nextName);
    setPrinterName(nextName);
    localStorage.setItem(`sf.print.printer.${bootstrap.env}`, nextName);
  };

  const prepare = (
    target: SfExpressWorkbenchRow,
    operation: 'print' | 'preview',
    retryOfRequestID = '',
  ) => {
    if (!target.currentSfOrder) throw new Error('顺丰记录不存在');
    return callFunction<PrepareResult>('manageSfPluginPrint', {
      data: {
        action: 'prepare',
        sfExpressOrderId: target.currentSfOrder._id,
        operation,
        ...(retryOfRequestID ? { retryOfRequestID } : {}),
      },
    });
  };

  const recordResult = (requestID: string, operation: 'print' | 'preview', result: SfSdkResult) => (
    callFunction<RecordResult>('manageSfPluginPrint', {
      data: {
        action: 'record',
        requestID,
        operation,
        code: result.code,
        apiResultCode: result.apiResultCode || '',
        msg: result.msg || '',
        printerName,
        clientPlatform: platform,
      },
    })
  );

  const executeOnce = async (
    target: SfExpressWorkbenchRow,
    operation: 'print' | 'preview',
    retryOfRequestID = '',
  ) => {
    if (!bootstrap?.partnerID || !bootstrap.env) throw new Error('插件打印配置尚未加载');
    const prepared = await prepare(target, operation, retryOfRequestID);
    if (!prepared.success) throw new Error(prepared.errMsg || '准备打印数据失败');
    if (prepared.env !== bootstrap.env) throw new Error('顺丰打印环境已变化，请刷新页面后重试');

    // accessToken 只存在于这个局部变量及 SDK 调用参数中，不写入 React 状态或本地存储。
    const { instance } = await getSfPrintPlugin(bootstrap.partnerID, bootstrap.env);
    if (printerName) setSfPrinter(instance, printerName);
    const printData: SfPluginPrintData = {
      requestID: prepared.requestID,
      accessToken: prepared.accessToken,
      templateCode: prepared.templateCode,
      ...(prepared.customTemplateCode ? { customTemplateCode: prepared.customTemplateCode } : {}),
      version: prepared.version,
      documents: prepared.documents,
    };
    const callback = await executeSfPluginPrint(instance, printData, operation);
    const recorded = await recordResult(prepared.requestID, operation, callback);
    return { prepared, callback, recorded };
  };

  const handlePluginOperation = async (operation: 'print' | 'preview') => {
    if (!primaryRecord || !pluginUsable || working) return;
    setWorking(operation);
    try {
      let result = await executeOnce(primaryRecord, operation);
      if (result.callback.code === 12 && result.callback.apiResultCode === 'A1011') {
        result = await executeOnce(primaryRecord, operation, result.prepared.requestID);
      }
      if (!result.recorded.success) throw new Error(result.recorded.errMsg || '打印结果记录失败');
      if (result.recorded.status === 'succeeded' && result.recorded.counted) {
        onPluginPrinted();
        MessagePlugin.success('顺丰丰密面单已发送到打印机');
        onClose();
        return;
      }
      if (result.recorded.status === 'previewed') {
        MessagePlugin.success('顺丰丰密面单预览已完成');
        return;
      }
      throw new Error(resultMessage(result.callback));
    } catch (error) {
      MessagePlugin.error('插件打印失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setWorking('');
    }
  };

  const handlePdf = async () => {
    if (!primaryRecord || working) return;
    setWorking('pdf');
    try {
      await onPdfPrint(primaryRecord);
      onClose();
    } finally {
      setWorking('');
    }
  };

  const handleBatchPluginPrint = async () => {
    if (!isBatch || !pluginUsable || !printerName || working) return;
    setWorking('batch');
    setBatchProgress(0);
    setBatchPrintingOrderId('');
    setBatchResults([]);

    const results: BatchPrintResult[] = [];
    try {
      for (let index = 0; index < records.length; index += 1) {
        const target = records[index];
        const sourceOrderId = target.order._id;
        setBatchPrintingOrderId(sourceOrderId);
        try {
          let result = await executeOnce(target, 'print');
          if (result.callback.code === 12 && result.callback.apiResultCode === 'A1011') {
            result = await executeOnce(target, 'print', result.prepared.requestID);
          }
          if (!result.recorded.success) throw new Error(result.recorded.errMsg || '打印结果记录失败');
          if (result.recorded.status !== 'succeeded') throw new Error(resultMessage(result.callback));
          results.push({
            sourceOrderId,
            orderLabel: getOrderLabel(target),
            waybillNo: target.currentSfOrder?.waybillNo || '',
            success: true,
          });
        } catch (error) {
          results.push({
            sourceOrderId,
            orderLabel: getOrderLabel(target),
            waybillNo: target.currentSfOrder?.waybillNo || '',
            success: false,
            errMsg: error instanceof Error ? error.message : String(error),
          });
        } finally {
          setBatchProgress(index + 1);
          setBatchResults([...results]);
        }
      }

      setBatchPrintingOrderId('');
      const succeeded = results.filter(result => result.success).length;
      const failed = results.length - succeeded;
      if (succeeded > 0) onPluginPrinted();
      if (failed > 0) {
        MessagePlugin.warning(`串行打印完成：成功 ${succeeded} 张，失败 ${failed} 张`);
      } else {
        MessagePlugin.success(`已依次发送 ${succeeded} 张面单到打印机`);
      }
    } finally {
      setBatchPrintingOrderId('');
      setWorking('');
    }
  };

  const installerUrl = pluginResult?.downloadUrl && isTrustedSfDownloadUrl(pluginResult.downloadUrl)
    ? pluginResult.downloadUrl
    : '';
  const currentBatchRecord = records.find(item => item.order._id === batchPrintingOrderId)
    || records[Math.min(batchProgress, Math.max(records.length - 1, 0))];

  return (
    <Dialog
      header={isBatch ? `串行打印顺丰面单（${records.length}）` : '打印顺丰丰密面单'}
      visible={records.length > 0}
      onClose={() => !working && onClose()}
      width={isBatch ? '760px' : '620px'}
      footer={false}
    >
      {primaryRecord && (
        <div className="space-y-4 text-sm">
          {isBatch ? (
            <>
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800">
                已选择 {records.length} 张面单。系统会等待当前面单发送完成，再处理下一张。
              </div>
              {working === 'batch' && currentBatchRecord && (
                <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 text-blue-700">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <LoaderCircle className="shrink-0 animate-spin" size={16} />
                      <span className="truncate">正在打印：{getOrderLabel(currentBatchRecord)}</span>
                    </div>
                    <span className="shrink-0 font-medium">{batchProgress} / {records.length}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-blue-100">
                    <div
                      className="h-full rounded bg-blue-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.round((batchProgress / records.length) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="max-h-[36vh] space-y-2 overflow-auto pr-1">
                {records.map(item => {
                  const result = batchResults.find(entry => entry.sourceOrderId === item.order._id);
                  const isPrinting = working === 'batch' && batchPrintingOrderId === item.order._id;
                  return (
                    <div
                      key={item.order._id}
                      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
                        isPrinting ? 'border-blue-300 bg-blue-50/70' : 'border-gray-200'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-gray-800">{getOrderLabel(item)}</div>
                        <div className="mt-1 text-xs text-gray-500">
                          运单号：{item.currentSfOrder?.waybillNo || '-'}
                        </div>
                        {result && !result.success && (
                          <div className="mt-1 text-xs text-rose-600">{result.errMsg || '打印失败'}</div>
                        )}
                      </div>
                      {isPrinting ? (
                        <Tag theme="warning" variant="light">
                          <span className="inline-flex items-center gap-1">
                            <LoaderCircle className="animate-spin" size={13} />打印中
                          </span>
                        </Tag>
                      ) : result ? (
                        <Tag theme={result.success ? 'success' : 'danger'} variant="light">
                          {result.success ? '已发送' : '失败'}
                        </Tag>
                      ) : (
                        <Tag theme="default" variant="light">等待中</Tag>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-gray-50 px-4 py-3">
                <div><span className="text-gray-500">订单：</span>{getOrderLabel(primaryRecord)}</div>
                <div className="mt-1"><span className="text-gray-500">运单号：</span>{primaryRecord.currentSfOrder?.waybillNo || '-'}</div>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                <div>
                  <div className="font-medium text-blue-900">免插件打印（推荐）</div>
                  <div className="mt-1 text-xs text-blue-700">
                    调用顺丰云打印接口生成官方 PDF，无需安装顺丰插件；请在随后打开的系统打印窗口中选择打印机。
                  </div>
                </div>
                <Button
                  theme="primary"
                  icon={<FileText size={16} />}
                  loading={working === 'pdf'}
                  disabled={!!working}
                  onClick={handlePdf}
                >
                  免插件打印
                </Button>
              </div>
            </>
          )}

          {platform === 'windows' ? (
            <div className="space-y-3 rounded-lg border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium text-gray-800">
                  {isBatch ? 'Windows 插件串行打印' : 'Windows 插件直接打印（可选）'}
                </div>
                <Tag theme={pluginUsable ? 'success' : 'warning'} variant="light">
                  {initializing ? '检测中' : pluginUsable ? '可用' : bootstrapError ? '初始化失败' : bootstrap?.pluginPrintEnabled === false ? '当前环境未开启' : '不可用'}
                </Tag>
              </div>

              {bootstrapError && (
                <div className="rounded bg-red-50 px-3 py-2 text-red-700">
                  插件初始化失败：{bootstrapError}
                </div>
              )}

              {pluginResult && pluginResult.code !== 1 && (
                <div className="rounded bg-amber-50 px-3 py-2 text-amber-700">
                  {resultMessage(pluginResult)}
                  {installerUrl && (
                    <a
                      className="ml-2 inline-flex items-center gap-1 underline"
                      href={installerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={14} />下载安装
                    </a>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Select
                  className="flex-1"
                  placeholder={pluginUsable ? '请选择打印机' : '插件可用后选择打印机'}
                  value={printerName}
                  options={printerOptions}
                  disabled={!pluginUsable || refreshing}
                  onChange={handlePrinterChange}
                />
                <Button
                  variant="outline"
                  icon={<RefreshCw size={15} />}
                  loading={refreshing}
                  disabled={(!pluginUsable && pluginResult?.code !== 4) || !!working}
                  onClick={() => refreshPrinters()}
                >
                  刷新
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {isBatch ? (
                  <Button
                    theme="primary"
                    icon={<Printer size={16} />}
                    loading={working === 'batch'}
                    disabled={!pluginUsable || !printerName || !!working || batchResults.length === records.length}
                    onClick={handleBatchPluginPrint}
                  >
                    开始串行打印（{records.length}）
                  </Button>
                ) : (
                  <>
                    <Button
                      theme="primary"
                      icon={<Printer size={16} />}
                      loading={working === 'print'}
                      disabled={!pluginUsable || !printerName || !!working}
                      onClick={() => handlePluginOperation('print')}
                    >
                      直接打印
                    </Button>
                    <Button
                      variant="outline"
                      icon={<Eye size={16} />}
                      loading={working === 'preview'}
                      disabled={!pluginUsable || !printerName || !!working}
                      onClick={() => handlePluginOperation('preview')}
                    >
                      打印预览
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-blue-700">
              {isBatch
                ? `批量串行打印需要 Windows 顺丰云打印插件，${platform === 'macos' ? 'macOS' : '当前系统'}可逐单使用免插件打印。`
                : `${platform === 'macos' ? 'macOS' : '当前系统'}请使用上方免插件打印。`}
            </div>
          )}
          {isBatch && batchResults.length === records.length && !working && (
            <div className="flex justify-end">
              <Button theme="primary" onClick={onClose}>关闭</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
