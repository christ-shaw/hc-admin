import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { CompanyTemplate } from '../types';

interface QueryResult {
  success?: boolean;
  data: CompanyTemplate[];
  cursor: string | null;
  hasMore: boolean;
}

interface SaveResult {
  success: boolean;
  errMsg?: string;
}

interface CompanyState {
  records: CompanyTemplate[];
  loading: boolean;
}

export function useCompanies() {
  const [state, setState] = useState<CompanyState>({
    records: [],
    loading: false,
  });

  const fetchRecords = useCallback(async (companyName?: string) => {
    setState(prev => ({ ...prev, loading: true }));
    try {
      const requestData: Record<string, unknown> = { limit: 50 };
      if (companyName) requestData.companyName = companyName;

      const result = await callFunction<QueryResult>('queryCompanies', { data: requestData });
      const records = result.data || [];
      setState({ records, loading: false });
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
        await fetchRecords();
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
        }));
        return true;
      }
      return false;
    } catch (err) {
      console.error('删除公司模版失败:', err);
      return false;
    }
  }, []);

  return {
    ...state,
    fetchRecords,
    addCompany,
    updateCompany,
    deleteCompany,
  };
}
