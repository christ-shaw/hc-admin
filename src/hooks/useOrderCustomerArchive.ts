import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomers } from './useCustomers';
import type { CustomerIdentityMatchResult, CustomerObservedIdentity } from '../types';

export function useOrderCustomerArchive(enabled: boolean, identity: CustomerObservedIdentity, choice?: boolean) {
  const { matchCustomerIdentity } = useCustomers();
  const key = JSON.stringify(identity);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const beginEditing = useCallback(() => setEditing(true), []);
  const endEditing = useCallback(() => setEditing(false), []);
  const inFlight = useRef(new Map<string, Promise<CustomerIdentityMatchResult>>());
  const [snapshot, setSnapshot] = useState<{ key: string; result?: CustomerIdentityMatchResult; error?: string } | null>(null);
  useEffect(() => {
    if (!enabled) { setSnapshot(null); setEditing(false); }
  }, [enabled]);
  useEffect(() => {
    let alive = true;
    if (!enabled || editing || !identity.customerName.trim() || snapshot?.key === key) return;
    let timeout: number | undefined;
    const timer = window.setTimeout(() => {
      let request = inFlight.current.get(key);
      if (!request) {
        request = matchCustomerIdentity(JSON.parse(key), true);
        inFlight.current.set(key, request);
      }
      const release = () => { if (inFlight.current.get(key) === request) inFlight.current.delete(key); };
      timeout = window.setTimeout(() => {
        if (alive) {
          alive = false;
          release();
          setSnapshot({ key, error: '客户检查超时，可继续保存订单，稍后在客户管理中归档。' });
        }
      }, 8000);
      request.then(result => {
        if (alive) setSnapshot({ key, result });
      }).catch(() => {
        if (alive) setSnapshot({ key, error: '客户检查暂不可用，可继续保存订单，稍后在客户管理中归档。' });
      }).finally(() => { window.clearTimeout(timeout); release(); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); window.clearTimeout(timeout); };
  // snapshot is deliberately not a trigger: edits invalidate it by identity key,
  // while focus/blur of unchanged fields reuse the already completed check.
  }, [enabled, editing, key, retry, matchCustomerIdentity]);
  const current = snapshot?.key === key ? snapshot : null;
  const visible = enabled && !!identity.customerName.trim();
  const candidates = current?.result?.candidates || [];
  const error = current?.error || (current?.result?.status === 'invalid_cluster' ? '客户资料需核对，可先保存订单，稍后归档。'
    : current?.result && !candidates.length && !current.result.archiveCheckId ? '客户检查结果暂不可用，可先保存订单，稍后归档。' : '');
  const checking = visible && !current;
  const available = visible && !checking && !error && candidates.length === 0;
  return { identityKey: key, visible, checking, waitingForBlur: checking && editing, error, candidates,
    archiveCheckId: available ? current?.result?.archiveCheckId : undefined,
    checked: available && choice !== false, available, beginEditing, endEditing,
    retry: () => { setSnapshot(null); setRetry(value => value + 1); } };
}

export type OrderCustomerArchivePlan = ReturnType<typeof useOrderCustomerArchive>;
