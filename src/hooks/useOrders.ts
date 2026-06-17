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

interface ApplyExpressResult {
  success: boolean;
  env?: string;
  orderId?: string;
  sfOrderId?: string;
  waybillNo?: string;
  errMsg?: string;
  errorCode?: string;
}

type QuerySfOrderResult = ApplyExpressResult;

interface CancelSfExpressResult extends ApplyExpressResult {
  resStatus?: string | number;
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

  /** 申请顺丰快递单 */
  const applySfExpress = useCallback(async (_id: string): Promise<ApplyExpressResult> => {
    try {
      const result = await callFunction<ApplyExpressResult>('applySfExpress', {
        data: { orderId: _id },
      });

      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            status: 'shipped',
            trackingNumber: result.waybillNo || r.trackingNumber,
            shippingFee: r.shippingFee || 'prepaid',
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressApplyStatus: 'applied',
            expressApplyTime: new Date().toISOString(),
            expressErrorMsg: '',
            sfOrderId: result.sfOrderId || r.sfOrderId,
            sfWaybillNo: result.waybillNo || r.sfWaybillNo,
          } : r),
        }));
      } else {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressApplyStatus: 'failed',
            expressErrorMsg: result.errMsg || '申请快递失败',
          } : r),
        }));
      }

      return result;
    } catch (err) {
      console.error('申请顺丰快递失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, []);

  /** 查询顺丰下单结果 */
  const querySfOrderResult = useCallback(async (_id: string): Promise<QuerySfOrderResult> => {
    try {
      const result = await callFunction<QuerySfOrderResult>('querySfOrderResult', {
        data: { orderId: _id },
      });

      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            status: 'shipped',
            trackingNumber: result.waybillNo || r.trackingNumber,
            shippingFee: r.shippingFee || 'prepaid',
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressApplyStatus: 'applied',
            expressApplyTime: new Date().toISOString(),
            expressErrorMsg: '',
            sfOrderId: result.sfOrderId || r.sfOrderId,
            sfWaybillNo: result.waybillNo || r.sfWaybillNo,
          } : r),
        }));
      } else {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressApplyStatus: 'failed',
            expressErrorMsg: result.errMsg || '查询顺丰下单结果失败',
            sfOrderId: result.sfOrderId || r.sfOrderId,
          } : r),
        }));
      }

      return result;
    } catch (err) {
      console.error('查询顺丰下单结果失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, []);

  /** 取消顺丰发货 */
  const cancelSfExpress = useCallback(async (_id: string): Promise<CancelSfExpressResult> => {
    try {
      const result = await callFunction<CancelSfExpressResult>('cancelSfExpress', {
        data: { orderId: _id },
      });

      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            status: 'unknown',
            trackingNumber: '',
            shippingFee: '',
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressApplyStatus: 'cancelled',
            expressCancelTime: new Date().toISOString(),
            expressErrorMsg: '',
            sfOrderId: result.sfOrderId || r.sfOrderId,
            sfWaybillNo: '',
          } : r),
        }));
      } else {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? {
            ...r,
            expressProvider: 'sf',
            sfEnv: result.env || r.sfEnv,
            expressErrorMsg: result.errMsg || '取消顺丰发货失败',
            sfOrderId: result.sfOrderId || r.sfOrderId,
          } : r),
        }));
      }

      return result;
    } catch (err) {
      console.error('取消顺丰发货失败:', err);
      return { success: false, errMsg: String(err) };
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

  /** 按条件全量查询订单（用于导出，自动分页获取全部） */
  const fetchAllRecords = useCallback(async (filters: OrderFilters): Promise<OrderRecord[]> => {
    const allRecords: OrderRecord[] = [];
    let skipCount = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const requestData: Record<string, unknown> = {
        limit,
        cursor: String(skipCount),
        ...filters,
      };
      const result = await callFunction<QueryResult>('queryOrders', { data: requestData });
      const records = result.data || [];
      allRecords.push(...records);
      skipCount += records.length;
      hasMore = result.hasMore !== undefined ? result.hasMore : (records.length >= limit);
      // 安全上限：最多 10000 条
      if (allRecords.length >= 10000) break;
    }

    return allRecords;
  }, []);

  return {
    ...state,
    fetchRecords,
    importOrders,
    deleteOrder,
    updateOrder,
    applySfExpress,
    querySfOrderResult,
    cancelSfExpress,
    resetFilters,
    getPageRecords,
    setCurrentPage,
    getAllRecords,
    fetchAllRecords,
  };
}
