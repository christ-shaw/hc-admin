import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { OutboundRecord, OutboundFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: OutboundRecord[];
  cursor: string | null;
  hasMore: boolean;
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
      const result = await callFunction<QueryResult>('queryRecords', { data: requestData });
      const records = result.data || [];
      const nextCursor = result.cursor;
      const hasMore = result.hasMore !== undefined ? result.hasMore : !!nextCursor;

      setState(prev => {
        const newRecords = cursor ? [...prev.records, ...records] : records;
        return {
          records: newRecords,
          cursor: nextCursor,
          hasMore,
          currentPage: Math.ceil(newRecords.length / PAGE_SIZE),
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
      const result = await callFunction<{ success: boolean }>('updateRecord', {
        data: { recordId, type: 'outbound', updateData },
      });
      return result?.success || false;
    } catch (err) {
      console.error('更新出库记录失败:', err);
      return false;
    }
  }, []);

  const deleteRecord = useCallback(async (recordId: string) => {
    try {
      const result = await callFunction<{ success: boolean }>('deleteOutboundRecord', {
        data: { _id: recordId },
      });
      return result?.success || false;
    } catch (err) {
      console.error('删除出库记录失败:', err);
      return false;
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

  const getPageRecords = useCallback((page: number): OutboundRecord[] => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

  return { ...state, fetchRecords, updateRecord, deleteRecord, resetFilters, getPageRecords };
}
