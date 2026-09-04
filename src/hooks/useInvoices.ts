import { useState, useCallback, useRef } from 'react';
import { callFunction } from '../lib/cloudbase';
import { InvoiceRecord, InvoiceFilters } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success: boolean;
  data: InvoiceRecord[];
  total: number;
  page: number;
  pageSize: number;
  errMsg?: string;
}

interface SaveResult {
  success: boolean;
  errMsg?: string;
}

interface InvoiceState {
  records: InvoiceRecord[];
  currentPage: number;
  pageSize: number;
  totalRecords: number;
  filters: InvoiceFilters;
  loading: boolean;
  error: string | null;
}

export function useInvoices() {
  const [state, setState] = useState<InvoiceState>({
    records: [],
    currentPage: 1,
    pageSize: PAGE_SIZE,
    totalRecords: 0,
    filters: {},
    loading: false,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestIdRef = useRef(0);

  const fetchRecords = useCallback(async (page = 1, filters?: InvoiceFilters, pageSize?: number) => {
    const requestId = ++requestIdRef.current;
    const currentFilters = { ...(filters ?? stateRef.current.filters) };
    const currentPageSize = pageSize ?? stateRef.current.pageSize;
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const result = await callFunction<QueryResult>('queryInvoices', {
        data: { ...currentFilters, page, pageSize: currentPageSize },
      });
      // 连续查询时只接受最后一次请求，防止旧条件的慢响应覆盖新结果。
      if (requestId !== requestIdRef.current) return null;
      if (!result?.success) throw new Error(result?.errMsg || '查询发票失败');
      if (!Array.isArray(result.data) || !Number.isInteger(result.total) || result.total < 0
        || !Number.isInteger(result.page) || result.page < 1
        || !Number.isInteger(result.pageSize) || result.pageSize < 1) {
        throw new Error('发票分页数据异常，请刷新后重试');
      }

      setState({
        records: result.data,
        currentPage: result.page,
        pageSize: result.pageSize,
        totalRecords: result.total,
        filters: currentFilters,
        loading: false,
        error: null,
      });
      return result;
    } catch (err) {
      if (requestId !== requestIdRef.current) return null;
      const error = err instanceof Error ? err.message : String(err);
      console.error('查询发票失败:', err);
      // 失败时保留上一次成功的列表和页码，不伪装成“没有数据”。
      setState(prev => ({ ...prev, loading: false, error }));
      return null;
    }
  }, []);

  const changePage = useCallback((page: number, pageSize = stateRef.current.pageSize) => {
    const targetPage = pageSize === stateRef.current.pageSize ? page : 1;
    return fetchRecords(targetPage, undefined, pageSize);
  }, [fetchRecords]);

  /** 新增后重新查询第一页，总数由服务端返回。 */
  const addInvoice = useCallback(async (invoice: Omit<InvoiceRecord, '_id' | 'createTime'>): Promise<SaveResult> => {
    try {
      const result = await callFunction<SaveResult>('saveInvoice', { data: { invoice } });
      if (result.success) await fetchRecords(1);
      return result;
    } catch (err) {
      console.error('新增发票失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, [fetchRecords]);

  /** 更新后重新查询，保持排序、筛选结果和总数一致。 */
  const updateInvoice = useCallback(async (_id: string, updateData: Partial<InvoiceRecord>): Promise<boolean> => {
    try {
      const result = await callFunction<SaveResult>('updateInvoice', { data: { _id, updateData } });
      if (!result.success) return false;
      await fetchRecords(stateRef.current.currentPage);
      return true;
    } catch (err) {
      console.error('更新发票失败:', err);
      return false;
    }
  }, [fetchRecords]);

  /** 删除后重新查询，避免本地移除导致后续分页漏查。 */
  const deleteInvoice = useCallback(async (_id: string): Promise<boolean> => {
    try {
      const result = await callFunction<SaveResult>('deleteInvoice', { data: { _id } });
      if (!result.success) return false;
      await fetchRecords(stateRef.current.currentPage);
      return true;
    } catch (err) {
      console.error('删除发票失败:', err);
      return false;
    }
  }, [fetchRecords]);

  return { ...state, fetchRecords, changePage, addInvoice, updateInvoice, deleteInvoice };
}
