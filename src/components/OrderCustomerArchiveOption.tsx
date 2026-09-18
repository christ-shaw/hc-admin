import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, MessagePlugin } from 'tdesign-react';
import { useCustomers } from '../hooks/useCustomers';
import type { OrderCustomerArchivePlan } from '../hooks/useOrderCustomerArchive';
import type { CustomerOrderLinkValue } from './CustomerOrderLinkFields';

export function OrderCustomerArchiveOption({ plan, onChoice, onSelect }: {
  plan: OrderCustomerArchivePlan;
  onChoice: (checked: boolean) => void;
  onSelect: (patch: Partial<CustomerOrderLinkValue>) => void;
}) {
  const { getOrderSelection } = useCustomers();
  const [selecting, setSelecting] = useState('');
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setSelecting('');
    return () => { request.current++; };
  }, [plan.identityKey, plan.visible]);
  if (!plan.visible) return null;
  const select = async (customerId: string) => {
    const version = ++request.current;
    setSelecting(customerId);
    try {
      const customer = await getOrderSelection(customerId);
      if (version !== request.current) return;
      // Keep the entered name and shipping snapshot; selecting a master need not
      // replace what the operator has already entered in the order.
      onSelect({ customerSelectionMode: 'explicit', customerId: customer._id, customerAliasId: '', recipientProfileId: '' });
    } catch (error) { if (version === request.current) MessagePlugin.warning(error instanceof Error ? error.message : '客户加载失败，请重试'); }
    finally { if (version === request.current) setSelecting(''); }
  };
  return <div className="mt-2 rounded-lg bg-blue-50/60 px-3 py-2 text-xs text-gray-600" aria-live="polite">
    {plan.checking ? <p>正在核对客户档案…</p> : plan.error ? <div>{plan.error}
      <Button size="small" variant="text" onClick={plan.retry}>重新检查</Button>
    </div> : plan.candidates.length ? <>
      <p>发现相似客户，可选择关联；暂不选择也能保存订单，后续归档。</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {plan.candidates.slice(0, 3).map(customer => <Button key={customer.customerId} size="small" variant="text"
          loading={selecting === customer.customerId} disabled={!!selecting} onClick={() => select(customer.customerId)}>
          关联 {customer.displayName || '已有客户'}
        </Button>)}
      </div>
    </> : <>
      <Checkbox checked={plan.checked} onChange={checked => onChoice(checked)}>保存订单时，同时建立客户档案</Checkbox>
      <p className="mt-1">使用本单名称及完整收件信息，无需重复填写。取消录单不会建档。</p>
    </>}
  </div>;
}
