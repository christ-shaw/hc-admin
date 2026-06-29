import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { InvoiceRecord, InvoiceFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: InvoiceRecord[];
  cursor: string | null;
  hasMore: boolean;
}

interface SaveResult {
  success: boolean;
  errMsg?: string;
}

interface InvoiceState {
  records: InvoiceRecord[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  totalRecords: number;
  filters: InvoiceFilters;
  loading: boolean;
}

export function useInvoices() {
  const [state, setState] = useState<InvoiceState>({
    records: [],
    cursor: null,
    hasMore: true,
    currentPage: 1,
    totalRecords: 0,
    filters: {},
    loading: false,
  });

  const fetchRecords = useCallback(async (cursor?: string | null, filters?: InvoiceFilters) => {
    setState(prev => ({ ...prev, loading: true }));
    const currentFilters = filters ?? state.filters;

    const requestData: Record<string, unknown> = {
      limit: PAGE_SIZE,
      cursor: cursor ?? null,
      ...currentFilters,
    };

    try {
      const result = await callFunction<QueryResult>('queryInvoices', { data: requestData });
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
      console.error('查询发票失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, [state.filters]);

  /** 新增发票 */
  const addInvoice = useCallback(async (invoice: Omit<InvoiceRecord, '_id' | 'createTime'>): Promise<SaveResult> => {
    try {
      const result = await callFunction<SaveResult>('saveInvoice', { data: { invoice } });
      if (result.success) {
        setState(prev => ({
          ...prev,
          records: [],
          cursor: null,
          hasMore: true,
          currentPage: 1,
          totalRecords: 0,
        }));
        await fetchRecords(null, state.filters);
      }
      return result;
    } catch (err) {
      console.error('新增发票失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, [fetchRecords, state.filters]);

  /** 更新发票 */
  const updateInvoice = useCallback(async (_id: string, updateData: Partial<InvoiceRecord>): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('updateInvoice', {
        data: { _id, updateData },
      });
      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? { ...r, ...updateData } : r),
        }));
        return true;
      }
      return false;
    } catch (err) {
      console.error('更新发票失败:', err);
      return false;
    }
  }, []);

  /** 删除发票 */
  const deleteInvoice = useCallback(async (_id: string): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('deleteInvoice', { data: { _id } });
      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.filter(r => r._id !== _id),
          totalRecords: prev.totalRecords - 1,
        }));
        return true;
      }
      return false;
    } catch (err) {
      console.error('删除发票失败:', err);
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

  const setCurrentPage = useCallback((page: number) => {
    setState(prev => {
      const totalPages = Math.max(1, Math.ceil(prev.records.length / PAGE_SIZE));
      const nextPage = Math.min(Math.max(1, page), totalPages);
      return { ...prev, currentPage: nextPage };
    });
  }, []);

  const goPreviousPage = useCallback(() => {
    setState(prev => ({ ...prev, currentPage: Math.max(1, prev.currentPage - 1) }));
  }, []);

  const goNextPage = useCallback(async () => {
    const nextPage = state.currentPage + 1;
    const loadedPages = Math.ceil(state.records.length / PAGE_SIZE);
    if (nextPage <= loadedPages) {
      setCurrentPage(nextPage);
      return;
    }
    if (state.hasMore) {
      await fetchRecords(state.cursor);
    }
  }, [fetchRecords, setCurrentPage, state.currentPage, state.cursor, state.hasMore, state.records.length]);

  const getPageRecords = useCallback((page: number): InvoiceRecord[] => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

  return {
    ...state,
    fetchRecords,
    addInvoice,
    updateInvoice,
    deleteInvoice,
    resetFilters,
    getPageRecords,
    setCurrentPage,
    goPreviousPage,
    goNextPage,
  };
}
