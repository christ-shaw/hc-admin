import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { OrderRecord, OrderFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: OrderRecord[];
  cursor: string | null;
  hasMore: boolean;
}

interface SaveResult {
  success: boolean;
  savedCount?: number;
  errMsg?: string;
}

interface OrderState {
  records: OrderRecord[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  totalRecords: number;
  filters: OrderFilters;
  loading: boolean;
}

export function useOrders() {
  const [state, setState] = useState<OrderState>({
    records: [],
    cursor: null,
    hasMore: true,
    currentPage: 1,
    totalRecords: 0,
    filters: {},
    loading: false,
  });

  const fetchRecords = useCallback(async (cursor?: string | null, filters?: OrderFilters) => {
    setState(prev => ({ ...prev, loading: true }));
    const currentFilters = filters ?? state.filters;

    const requestData: Record<string, unknown> = {
      limit: PAGE_SIZE,
      cursor: cursor ?? null,
      ...currentFilters,
    };

    try {
      const result = await callFunction<QueryResult>('queryOrders', { data: requestData });
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
      console.error('查询订单失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, [state.filters]);

  /** 批量导入订单 */
  const importOrders = useCallback(async (orders: OrderRecord[]): Promise<SaveResult> => {
    try {
      const result = await callFunction<SaveResult>('saveOrders', { data: { orders } });
      if (result.success) {
        // 导入成功后刷新列表
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
      console.error('导入订单失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, [fetchRecords, state.filters]);

  /** 删除订单 */
  const deleteOrder = useCallback(async (_id: string): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('deleteOrder', { data: { _id } });
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
      console.error('删除订单失败:', err);
      return false;
    }
  }, []);

  /** 更新订单 */
  const updateOrder = useCallback(async (_id: string, updateData: Partial<OrderRecord>): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('updateOrder', {
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
      console.error('更新订单失败:', err);
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
    setState(prev => ({ ...prev, currentPage: page }));
  }, []);

  const getPageRecords = useCallback((page: number): OrderRecord[] => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

  /** 获取所有记录（用于导出） */
  const getAllRecords = useCallback((): OrderRecord[] => {
    return state.records;
  }, [state.records]);

  return {
    ...state,
    fetchRecords,
    importOrders,
    deleteOrder,
    updateOrder,
    resetFilters,
    getPageRecords,
    setCurrentPage,
    getAllRecords,
  };
}
