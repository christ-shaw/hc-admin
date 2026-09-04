import { useCallback, useState } from 'react';
import { callFunction } from '../lib/cloudbase';
import type { CustomerDetail, CustomerRecord } from '../types';

export interface CustomerListItem extends CustomerRecord {
  aliasCount: number;
  recipientCount: number;
}

interface CustomerResult<T> {
  success: boolean;
  data?: T;
  total?: number;
  errMsg?: string;
}

export function useCustomers() {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [total, setTotal] = useState(0);

  const loadCustomers = useCallback(async (options: { keyword?: string; includeDisabled?: boolean; pageSize?: number } = {}) => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await callFunction<CustomerResult<CustomerListItem[]>>('manageCustomers', {
        action: 'list',
        keyword: options.keyword || '',
        includeDisabled: options.includeDisabled === true,
        pageSize: options.pageSize || 5000,
      });
      if (!result.success) throw new Error(result.errMsg || '加载客户失败');
      const rows = result.data || [];
      setCustomers(rows);
      setTotal(result.total ?? rows.length);
      return rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载客户失败';
      setCustomers([]);
      setTotal(0);
      setLoadError(message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const getCustomer = useCallback(async (customerId: string) => {
    const result = await callFunction<CustomerResult<CustomerDetail>>('manageCustomers', { action: 'get', customerId });
    if (!result.success || !result.data) throw new Error(result.errMsg || '加载客户详情失败');
    return result.data;
  }, []);

  const mutate = useCallback(async (action: string, data: Record<string, unknown> = {}) => {
    const result = await callFunction<CustomerResult<{ _id?: string; primaryAliasId?: string }>>('manageCustomers', { action, ...data });
    if (!result.success) throw new Error(result.errMsg || '客户资料保存失败');
    return result.data;
  }, []);

  return { customers, loading, loadError, total, loadCustomers, getCustomer, mutate };
}
