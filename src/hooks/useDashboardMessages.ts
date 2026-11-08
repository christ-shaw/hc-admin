import { useCallback, useEffect, useRef, useState } from 'react';
import { callFunction } from '../lib/cloudbase';
import { OrderRecord } from '../types';

interface Category {
  total: number;
  orders: OrderRecord[];
}
export interface DashboardMessageSummary {
  unreturned: Category;
  unreceived: Category;
}

export function useDashboardMessages() {
  const [summary, setSummary] = useState<DashboardMessageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const pending = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    setLoading(true);
    setError(null);
    // Defer the call so the guard is installed even if the SDK throws synchronously.
    const request = Promise.resolve().then(async () => {
      try {
        const result = await callFunction<{ success: boolean; data: DashboardMessageSummary }>(
          'queryOrders', { data: { action: 'dynamicMessages' } },
        );
        const valid = (value: Category | undefined) => value && Number.isFinite(value.total)
          && value.total >= 0 && Array.isArray(value.orders);
        if (!result.success || !valid(result.data?.unreturned) || !valid(result.data?.unreceived)) {
          throw new Error('动态消息返回异常');
        }
        if (active.current) setSummary(result.data);
      } catch (err) {
        console.error('获取首页动态消息失败:', err);
        if (active.current) setError('动态消息加载失败，请点击刷新重试');
      } finally {
        pending.current = null;
        if (active.current) setLoading(false);
      }
    });
    pending.current = request;
    return request;
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { summary, loading, error, refresh };
}
