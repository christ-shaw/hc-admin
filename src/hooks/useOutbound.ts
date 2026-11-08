import { useState, useCallback, useRef } from 'react';
import { callFunction, getCurrentPermissionUserPayload } from '../lib/cloudbase';
import { OutboundRecord, OutboundFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: OutboundRecord[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
  errMsg?: string;
}

interface OutboundState {
  records: OutboundRecord[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  totalRecords: number;
  filters: OutboundFilters;
  loading: boolean;
  error: string | null;
}

interface SyncModelsResult {
  success: boolean;
  phoneModels?: OutboundRecord['phoneModels'];
  remark?: string;
  changed?: boolean;
  errMsg?: string;
}

export function useOutbound() {
  const [state, setState] = useState<OutboundState>({
    records: [],
    cursor: null,
    hasMore: false,
    currentPage: 1,
    totalRecords: 0,
    filters: {},
    loading: false,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestIdRef = useRef(0);

  const fetchRecords = useCallback(async (cursor?: string | null, filters?: OutboundFilters) => {
    const requestId = ++requestIdRef.current;
    const currentFilters = { ...(filters ?? stateRef.current.filters) };
    const offset = Math.max(0, Number(cursor) || 0);
    setState(prev => ({ ...prev, records: [], cursor: null, hasMore: false,
      currentPage: Math.floor(offset / PAGE_SIZE) + 1, totalRecords: 0,
      filters: currentFilters, loading: true, error: null }));

    const requestData: Record<string, unknown> = {
      type: 'outbound',
      limit: PAGE_SIZE,
      cursor: cursor ?? null,
      ...currentFilters,
    };

    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<QueryResult>('queryRecords', { data: { ...requestData, currentUser } });
      if (requestId !== requestIdRef.current) return null;
      if (result.success === false) throw new Error(result.errMsg || '查询出库记录失败');
      if (!Array.isArray(result.data) || !Number.isInteger(result.total) || result.total < 0) {
        throw new Error('出库查询结果异常，请重试');
      }
      const records = Array.from(new Map(result.data.map(record => [record._id, record])).values());
      const nextCursor = result.cursor == null ? null : String(result.cursor);
      const hasMore = result.hasMore !== undefined ? result.hasMore : !!nextCursor;

      setState({
          records,
          cursor: nextCursor,
          hasMore,
          currentPage: Math.floor(offset / PAGE_SIZE) + 1,
          totalRecords: result.total,
          filters: currentFilters,
          loading: false,
          error: null,
      });

      return { records, nextCursor, hasMore };
    } catch (err) {
      if (requestId !== requestIdRef.current) return null;
      console.error('查询出库记录失败:', err);
      setState(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  }, []);

  const updateRecord = useCallback(async (recordId: string, updateData: Partial<OutboundRecord>) => {
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{ success: boolean; errMsg?: string }>('updateRecord', {
        data: { recordId, type: 'outbound', updateData, currentUser },
      });
      if (!result?.success && result?.errMsg) throw new Error(result.errMsg);
      return result?.success || false;
    } catch (err) {
      console.error('更新出库记录失败:', err);
      throw err;
    }
  }, []);

  const syncModelsFromOrders = useCallback(async (recordId: string): Promise<SyncModelsResult> => {
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{
        success: boolean;
        errMsg?: string;
        data?: { phoneModels?: OutboundRecord['phoneModels']; remark?: string; changed?: boolean };
      }>('updateRecord', {
        data: { recordId, type: 'outbound', syncFromOrders: true, currentUser },
      });
      return {
        success: !!result?.success,
        phoneModels: result?.data?.phoneModels,
        remark: result?.data?.remark,
        changed: result?.data?.changed,
        errMsg: result?.errMsg,
      };
    } catch (err) {
      console.error('从订单同步出库型号失败:', err);
      return { success: false, errMsg: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const deleteRecord = useCallback(async (recordId: string) => {
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{ success: boolean; errMsg?: string }>('deleteOutboundRecord', {
        data: { _id: recordId, currentUser },
      });
      if (!result?.success && result?.errMsg) throw new Error(result.errMsg);
      return result?.success || false;
    } catch (err) {
      console.error('删除出库记录失败:', err);
      throw err;
    }
  }, []);

  const changePage = useCallback((page: number) => {
    return fetchRecords(String((Math.max(1, page) - 1) * PAGE_SIZE));
  }, [fetchRecords]);

  /** 按条件获取全部出库记录（用于导出，自动分页）。 */
  const fetchAllRecords = useCallback(async (filters: OutboundFilters): Promise<OutboundRecord[]> => {
    const allRecords: OutboundRecord[] = [];
    const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
    let cursor = 0;
    let hasMore = true;

    while (hasMore && allRecords.length < 10000) {
      const result = await callFunction<QueryResult>('queryRecords', {
        data: {
          type: 'outbound',
          limit: 100,
          cursor: String(cursor),
          ...filters,
          currentUser,
        },
      });
      if (!result.success && result.errMsg) throw new Error(result.errMsg);
      const records = result.data || [];
      allRecords.push(...records);
      cursor += records.length;
      hasMore = result.hasMore === true && records.length > 0;
    }

    return allRecords.slice(0, 10000);
  }, []);

  return { ...state, fetchRecords, fetchAllRecords, updateRecord, syncModelsFromOrders, deleteRecord, changePage };
}
