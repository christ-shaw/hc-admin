import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { CompanyTemplate } from '../types';
import { PAGE_SIZE } from '../utils/constants';

interface QueryResult {
  success?: boolean;
  data: CompanyTemplate[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
}

interface SaveResult {
  success: boolean;
  errMsg?: string;
}

interface CompanyState {
  records: CompanyTemplate[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  totalRecords: number;
  loading: boolean;
}

export function useCompanies() {
  const [state, setState] = useState<CompanyState>({
    records: [],
    cursor: null,
    hasMore: true,
    currentPage: 1,
    totalRecords: 0,
    loading: false,
  });

  const fetchRecords = useCallback(async (cursor?: string | null, companyName?: string) => {
    setState(prev => ({ ...prev, loading: true }));
    try {
      const requestData: Record<string, unknown> = { limit: PAGE_SIZE, cursor: cursor ?? null };
      if (companyName) requestData.companyName = companyName;

      const result = await callFunction<QueryResult>('queryCompanies', { data: requestData });
      const records = result.data || [];
      const append = cursor !== undefined && cursor !== null && cursor !== '';
      setState(prev => {
        const nextRecords = append ? [...prev.records, ...records] : records;
        const loadedPages = Math.max(1, Math.ceil(nextRecords.length / PAGE_SIZE));
        return {
          records: nextRecords,
          cursor: result.cursor,
          hasMore: result.hasMore,
          currentPage: append ? Math.min(prev.currentPage + 1, loadedPages) : 1,
          totalRecords: Number(result.total ?? nextRecords.length),
          loading: false,
        };
      });
      return records;
    } catch (err) {
      console.error('查询公司模版失败:', err);
      setState(prev => ({ ...prev, loading: false }));
      return [];
    }
  }, []);

  const addCompany = useCallback(async (company: Omit<CompanyTemplate, '_id' | 'createTime'>): Promise<SaveResult> => {
    try {
      const result = await callFunction<SaveResult>('saveCompany', { data: { company } });
      if (result.success) {
        await fetchRecords(null);
      }
      return result;
    } catch (err) {
      console.error('新增公司模版失败:', err);
      return { success: false, errMsg: String(err) };
    }
  }, [fetchRecords]);

  const updateCompany = useCallback(async (_id: string, updateData: Partial<CompanyTemplate>): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('updateCompany', { data: { _id, updateData } });
      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.map(r => r._id === _id ? { ...r, ...updateData } : r),
        }));
        return true;
      }
      return false;
    } catch (err) {
      console.error('更新公司模版失败:', err);
      return false;
    }
  }, []);

  const deleteCompany = useCallback(async (_id: string): Promise<boolean> => {
    try {
      const result = await callFunction<{ success: boolean }>('deleteCompany', { data: { _id } });
      if (result.success) {
        setState(prev => ({
          ...prev,
          records: prev.records.filter(r => r._id !== _id),
          totalRecords: Math.max(0, prev.totalRecords - 1),
        }));
        return true;
      }
      return false;
    } catch (err) {
      console.error('删除公司模版失败:', err);
      return false;
    }
  }, []);

  const setCurrentPage = useCallback((page: number) => {
    setState(prev => ({ ...prev, currentPage: page }));
  }, []);

  const getPageRecords = useCallback((page: number) => {
    const start = (page - 1) * PAGE_SIZE;
    return state.records.slice(start, start + PAGE_SIZE);
  }, [state.records]);

  return {
    ...state,
    fetchRecords,
    addCompany,
    updateCompany,
    deleteCompany,
    setCurrentPage,
    getPageRecords,
  };
}
