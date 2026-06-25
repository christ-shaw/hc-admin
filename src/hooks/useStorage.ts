import { useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { RECORD_TYPE_MAP, LOG_ACTION_MAP } from '../data/dict';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';

export function useStorage() {
  const dictionaries = useDictionaries();

  const getRealImageUrl = useCallback(async (fileID: string): Promise<string> => {
    if (!fileID) return '';

    try {
      const result = await callFunction<{ realUrl?: string }>('getRealImageUrl', { fileID });
      if (result.realUrl) return result.realUrl;
    } catch (err) {
      console.error('获取真实图片地址失败:', err);
    }

    return fileID;
  }, []);

  const notifyRecordChange = useCallback(async (
    action: string,
    recordType: string,
    record: Record<string, unknown>,
    operationLogId?: string | null
  ) => {
    try {
      const typeName = RECORD_TYPE_MAP[recordType as keyof typeof RECORD_TYPE_MAP] || recordType;
      const actionName = LOG_ACTION_MAP[action as keyof typeof LOG_ACTION_MAP] || action;

      let detailContent = '';
      if (action === 'delete') {
        detailContent = `客户: ${(record.customerName as string) || '未知'}`;
      } else {
        const date = (record.inboundDate || record.outboundDate || '') as string;
        const channelType = dictionaries.getLabel(DICT_CODES.channelType, record.type as string) || '';
        const shopName = (record.shopName as string) || '';

        detailContent = `客户: ${(record.customerName as string) || '未知'}\n日期: ${date}\n渠道: ${channelType}\n店铺: ${shopName}`;

        const phoneModels = record.phoneModels as { model: string; quantity: number }[] | undefined;
        if (phoneModels && phoneModels.length > 0) {
          const modelsText = phoneModels.map(m => `${m.model} x ${m.quantity}`).join(', ');
          detailContent += `\n型号: ${modelsText}`;
        }
      }

      if (operationLogId) {
        detailContent += `\n\n日志ID: ${operationLogId}`;
      }

      const title = `📦 租赁记录${actionName}`;
      const content = `${typeName}记录${actionName}\n\n${detailContent}`;

      const timestamp = new Date().toLocaleString('zh-CN');
      const messageContent = `【${title}】\n${content}\n\n时间: ${timestamp}`;

      await callFunction('sendWechatNotification', {
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=d264c1c4-1c55-4dee-a4c9-e772460c8753',
        msgtype: 'text',
        content: messageContent,
      });
    } catch (err) {
      console.error('企业微信推送异常:', err);
    }
  }, [dictionaries]);

  return { getRealImageUrl, notifyRecordChange };
}
