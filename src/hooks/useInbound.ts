import { useState, useCallback } from 'react';
import { callFunction, getCurrentPermissionUserPayload } from '../lib/cloudbase';
import { InboundRecord, InboundFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: InboundRecord[];
  cursor: string | null;
  hasMore: boolean;
  errMsg?: string;
}

interface InboundState {
  records: InboundRecord[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  totalRecords: number;
  filters: InboundFilters;
  loading: boolean;
}

export function useInbound() {
  const [state, setState] = useState<InboundState>({
    records: [],
    cursor: null,
    hasMore: true,
    currentPage: 1,
    totalRecords: 0,
    filters: {},
    loading: false,
  });

  const fetchRecords = useCallback(async (cursor?: string | null, filters?: InboundFilters) => {
    setState(prev => ({ ...prev, loading: true }));
    const currentFilters = filters ?? state.filters;

    const requestData: Record<string, unknown> = {
      type: 'inbound',
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
      console.error('查询入库记录失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, [state.filters]);

  const updateRecord = useCallback(async (recordId: string, updateData: Partial<InboundRecord>) => {
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{ success: boolean; errMsg?: string }>('updateRecord', {
        data: { recordId, type: 'inbound', updateData, currentUser },
      });
      if (!result?.success && result?.errMsg) throw new Error(result.errMsg);
      return result?.success || false;
    } catch (err) {
      console.error('更新入库记录失败:', err);
      throw err;
    }
  }, []);

  const deleteRecord = useCallback(async (recordId: string) => {
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{ success: boolean; errMsg?: string }>('deleteInboundRecord', {
        data: { _id: recordId, currentUser },
      });
      if (!result?.success && result?.errMsg) throw new Error(result.errMsg);
      return result?.success || false;
    } catch (err) {
      console.error('删除入库记录失败:', err);
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

  const getPageRecords = useCallback((page: number): InboundRecord[] => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

  return { ...state, fetchRecords, updateRecord, deleteRecord, resetFilters, getPageRecords, setCurrentPage };
}
