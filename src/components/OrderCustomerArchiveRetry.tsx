import { useState } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import { callFunction } from '../lib/cloudbase';

export interface OrderCustomerArchiveResult {
  orderId: string;
  status: 'created' | 'linked' | 'pending';
  message?: string;
  customerId?: string;
}

export function OrderCustomerArchiveRetry({ orderId, serialNumber, onComplete }: {
  orderId: string; serialNumber: number; onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('订单已保存，客户档案待补建。');
  return <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
    <span>订单 #{serialNumber}：{message}</span>
    <Button size="small" variant="text" loading={loading} onClick={async () => {
      if (loading) return;
      setLoading(true);
      try {
        const result = await callFunction<{ success: boolean; data?: OrderCustomerArchiveResult; errMsg?: string }>('manageCustomers', {
          action: 'createFromOrder', orderId,
        });
        if (!result.success || !result.data) throw new Error(result.errMsg || '建档失败，请重试');
        if (result.data.status === 'pending') setMessage(result.data.message || '档案需核对，请在客户管理中归档。');
        else { MessagePlugin.success('客户档案已关联'); onComplete(); }
      } catch (error) { setMessage(error instanceof Error ? error.message : '建档失败，请重试'); }
      finally { setLoading(false); }
    }}>重试建档</Button>
  </div>;
}
