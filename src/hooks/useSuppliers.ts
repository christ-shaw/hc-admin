import { useCallback, useState } from 'react';
import { callFunction } from '../lib/cloudbase';

export interface Supplier {
  _id: string;
  name: string;
  contactName: string;
  phone: string;
  address: string;
  remark: string;
  enabled: boolean;
  sort: number;
  createdAt?: string;
  updatedAt?: string;
}

interface SupplierListResult {
  success: boolean;
  data?: Supplier[];
  errMsg?: string;
}

export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadSuppliers = useCallback(async (enabledOnly = true) => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await callFunction<SupplierListResult>('manageSuppliers', {
        action: 'list',
        enabledOnly,
      });
      if (!result.success) {
        setSuppliers([]);
        setLoadError(result.errMsg || '加载供应商失败');
        return [];
      }
      const data = result.data || [];
      setSuppliers(data);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载供应商失败';
      setSuppliers([]);
      setLoadError(message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return { suppliers, loading, loadError, loadSuppliers };
}
