import { useState, useCallback } from 'react';
import { callFunction, getCurrentPermissionUserPayload } from '../lib/cloudbase';
import { OutboundRecord, OutboundFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: OutboundRecord[];
  cursor: string | null;
  hasMore: boolean;
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
    hasMore: true,
    currentPage: 1,
    totalRecords: 0,
    filters: {},
    loading: false,
  });

  const fetchRecords = useCallback(async (cursor?: string | null, filters?: OutboundFilters) => {
    setState(prev => ({ ...prev, loading: true }));
    const currentFilters = filters ?? state.filters;

    const requestData: Record<string, unknown> = {
      type: 'outbound',
      limit: PAGE_SIZE,
      cursor: cursor ?? null,
      ...currentFilters,
    };

    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<QueryResult>('queryRecords', { data: { ...requestData, currentUser } });
      if (!result.success && result.errMsg) throw new Error(result.errMsg);
      const records = result.data || [];
      const nextCursor = result.cursor;
      const hasMore = result.hasMore !== undefined ? result.hasMore : !!nextCursor;

      setState(prev => {
        const newRecords = cursor ? [...prev.records, ...records] : records;
        const totalPages = Math.ceil(newRecords.length / PAGE_SIZE);
        return {
          records: newRecords,
          cursor: nextCursor,
          hasMore,
          currentPage: cursor ? Math.min(prev.currentPage + 1, totalPages) : 1,
          totalRecords: newRecords.length,
          filters: currentFilters,
          loading: false,
        };
      });

      return { records, nextCursor, hasMore };
    } catch (err) {
      console.error('查询出库记录失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, [state.filters]);

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

  const resetFilters = useCallback(() => {
    setState(prev => ({
      ...prev,
      records: [],
      cursor: null,
      hasMore: true,
      currentPage: 1,
      totalRecords: 0,
      filters: {},
    }));
  }, []);

  const setCurrentPage = useCallback((page: number) => {
    setState(prev => ({ ...prev, currentPage: page }));
  }, []);

  const getPageRecords = useCallback((page: number): OutboundRecord[] => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

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

  return { ...state, fetchRecords, fetchAllRecords, updateRecord, syncModelsFromOrders, deleteRecord, resetFilters, getPageRecords, setCurrentPage };
}
