import { useCallback, useRef, useState } from 'react';
import { customerWriteRequest } from '../utils/customerWriteRequest';
import { callFunction } from '../lib/cloudbase';
import type { CustomerDetail, CustomerRecord, CustomerOrderSelection, CustomerSelectionItem, CustomerSuggestion, CustomerObservedIdentity, CustomerIdentityMatchResult, CustomerIdentityCheckResult } from '../types';

export interface CustomerListItem extends CustomerRecord {
  aliasCount: number;
  recipientCount: number;
}

interface CustomerResult<T> {
  success: boolean;
  data?: T;
  total?: number;
  page?: number;
  pageSize?: number;
  errMsg?: string;
}

export function useCustomers() {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [total, setTotal] = useState(0);
  const listRequest = useRef(0);

  const loadCustomers = useCallback(async (options: { keyword?: string; includeDisabled?: boolean; page?: number; pageSize?: number } = {}) => {
    const request = ++listRequest.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await callFunction<CustomerResult<CustomerListItem[]>>('manageCustomers', {
        action: 'list',
        keyword: options.keyword || '',
        includeDisabled: options.includeDisabled === true,
        page: options.page || 1,
        pageSize: options.pageSize || 20,
      });
      if (!result.success) throw new Error(result.errMsg || '加载客户失败');
      const rows = result.data || [];
      if (request !== listRequest.current) return rows;
      setCustomers(rows);
      setTotal(result.total ?? rows.length);
      return rows;
    } catch (error) {
      if (request !== listRequest.current) return [];
      const message = error instanceof Error ? error.message : '加载客户失败';
      setCustomers([]);
      setTotal(0);
      setLoadError(message);
      return [];
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, []);

  const searchCustomers = useCallback(async (keyword: string, page = 1) => {
    const result = await callFunction<CustomerResult<CustomerSelectionItem[]>>('manageCustomers', {
      action: 'search', keyword, page, pageSize: 20,
    });
    if (!result.success) throw new Error(result.errMsg || '搜索客户失败');
    return { data: result.data || [], total: result.total || 0 };
  }, []);

  const getOrderSelection = useCallback(async (customerId: string, aliasPage = 1, recipientPage = 1) => {
    const result = await callFunction<CustomerResult<CustomerOrderSelection>>('manageCustomers', {
      action: 'get', scope: 'orderSelection', customerId, aliasPage, recipientPage, pageSize: 20,
    });
    if (!result.success || !result.data) throw new Error(result.errMsg || '加载客户可选资料失败');
    return result.data;
  }, []);

  const suggestCustomers = useCallback(async (keyword: string, salesChannel: string) => {
    const result = await callFunction<CustomerResult<CustomerSuggestion[]>>('manageCustomers', {
      action: 'search', scope: 'orderSuggestions', keyword, salesChannel,
    });
    if (!result.success) throw new Error(result.errMsg || '推荐暂不可用，可继续手动填写');
    return result.data || [];
  }, []);

  const getCustomer = useCallback(async (customerId: string) => {
    const result = await callFunction<CustomerResult<CustomerDetail>>('manageCustomers', { action: 'get', customerId });
    if (!result.success || !result.data) throw new Error(result.errMsg || '加载客户详情失败');
    return result.data;
  }, []);

  const matchCustomerIdentity = useCallback(async (identity: CustomerObservedIdentity) => {
    const result = await callFunction<CustomerResult<CustomerIdentityMatchResult>>('manageCustomers', { action: 'matchIdentity', identity });
    if (!result.success || !result.data) throw new Error(result.errMsg || '客户身份匹配失败');
    return result.data;
  }, []);

  const checkCustomerIdentity = useCallback(async (identity: CustomerObservedIdentity, cached?: { identityRevision?: number; normalizationVersion?: string }) => {
    const result = await callFunction<CustomerResult<CustomerIdentityCheckResult>>('manageCustomers', {
      action: 'matchIdentity', identity,
      ...(cached ? { knownIdentityRevision: cached.identityRevision, knownNormalizationVersion: cached.normalizationVersion } : {}),
    });
    if (!result.success || !result.data) throw new Error(result.errMsg || '客户身份检查失败');
    return result.data;
  }, []);

  const mutate = useCallback(async (action: string, data: Record<string, unknown> = {}) => {
    return customerWriteRequest(action, data, async requestId => {
      const result = await callFunction<CustomerResult<{ _id?: string; primaryAliasId?: string }>>('manageCustomers', { ...data, action, requestId });
      if (!result.success) throw new Error(result.errMsg || '客户资料保存失败');
      return result.data;
    });
  }, []);

  return { customers, loading, loadError, total, loadCustomers, getCustomer, searchCustomers, suggestCustomers, getOrderSelection, matchCustomerIdentity, checkCustomerIdentity, mutate };
}
