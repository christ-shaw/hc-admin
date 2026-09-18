import { useEffect, useState } from 'react';
import { useCustomers } from './useCustomers';
import type { CustomerIdentityMatchResult, CustomerObservedIdentity } from '../types';

export function useOrderCustomerArchive(enabled: boolean, identity: CustomerObservedIdentity, choice?: boolean) {
  const { matchCustomerIdentity } = useCustomers();
  const key = JSON.stringify(identity);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; result?: CustomerIdentityMatchResult; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setSnapshot(null);
    if (!enabled || !identity.customerName.trim()) return;
    const timeout = window.setTimeout(() => {
      if (alive) {
        alive = false;
        setSnapshot({ key, error: '客户检查超时，可继续保存订单，稍后在客户管理中归档。' });
      }
    }, 8000);
    const timer = window.setTimeout(() => {
      matchCustomerIdentity(JSON.parse(key)).then(result => {
        window.clearTimeout(timeout);
        if (alive) setSnapshot({ key, result });
      }).catch(() => {
        window.clearTimeout(timeout);
        if (alive) setSnapshot({ key, error: '客户检查暂不可用，可继续保存订单，稍后在客户管理中归档。' });
      });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [enabled, key, retry, matchCustomerIdentity]);
  const current = snapshot?.key === key ? snapshot : null;
  const visible = enabled && !!identity.customerName.trim();
  const candidates = current?.result?.candidates || [];
  const error = current?.error || (current?.result?.status === 'invalid_cluster' ? '客户资料需核对，可先保存订单，稍后归档。' : '');
  const checking = visible && !current;
  const available = visible && !checking && !error && candidates.length === 0;
  return { identityKey: key, visible, checking, error, candidates, checked: available && choice !== false, available,
    retry: () => setRetry(value => value + 1) };
}

export type OrderCustomerArchivePlan = ReturnType<typeof useOrderCustomerArchive>;
