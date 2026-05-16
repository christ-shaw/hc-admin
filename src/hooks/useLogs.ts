import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { OperationLog, LogFilters } from '../types';

interface LogsState {
  records: OperationLog[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
  loading: boolean;
}

export function useLogs() {
  const [state, setState] = useState<LogsState>({
    records: [],
    cursor: null,
    hasMore: false,
    total: 0,
    loading: false,
  });

  const fetchLogs = useCallback(async (cursor?: string | null, filters?: LogFilters) => {
    setState(prev => ({ ...prev, loading: true }));

    const requestData: Record<string, unknown> = { limit: 20 };
    if (cursor) requestData.cursor = cursor;
    if (filters) {
      if (filters.operationType) requestData.operationType = filters.operationType;
      if (filters.logType) requestData.logType = filters.logType;
      if (filters.operator) requestData.operator = filters.operator;
      if (filters.startDate) requestData.startDate = filters.startDate;
      if (filters.endDate) requestData.endDate = filters.endDate;
    }

    try {
      const result = await callFunction<{
        success?: boolean;
        data: OperationLog[];
        cursor: string | null;
        hasMore: boolean;
        total: number;
      }>('getOperationLogs', requestData);

      setState(prev => ({
        records: cursor ? [...prev.records, ...result.data] : result.data,
        cursor: result.cursor,
        hasMore: result.hasMore,
        total: result.total,
        loading: false,
      }));

      return result;
    } catch (err) {
      console.error('查询操作日志失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, []);

  const fetchRecordHistory = useCallback(async (recordId: string) => {
    try {
      const result = await callFunction<{
        success: boolean;
        data: Array<{
          _id: string;
          operationType: string;
          operator: string;
          operationTime: string;
          changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
        }>;
        total: number;
      }>('getRecordHistory', { data: { recordId } });
      return result;
    } catch (err) {
      console.error('查询修改历史失败:', err);
      return null;
    }
  }, []);

  const saveOperationLog = useCallback(async (
    operationType: string,
    logType: string,
    logId: string,
    operationContent: string,
    operator: string
  ) => {
    try {
      const result = await callFunction<{ success: boolean; _id?: string }>('saveOperationLog', {
        operationType, logType, logId, operationContent, operator,
      });
      return result;
    } catch (err) {
      console.error('保存操作日志失败:', err);
      return { success: false };
    }
  }, []);

  return { ...state, fetchLogs, fetchRecordHistory, saveOperationLog };
}
