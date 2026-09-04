import { useEffect, useMemo, useState } from 'react';
import { Button, Select } from 'tdesign-react';
import type { CustomerDetail } from '../types';
import { useCustomers } from '../hooks/useCustomers';

export interface CustomerOrderLinkValue {
  customerId: string;
  customerAliasId: string;
  recipientProfileId: string;
  customerName: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddress: string;
}

export function CustomerOrderLinkFields({
  value,
  salesChannel,
  onChange,
}: {
  value: CustomerOrderLinkValue;
  salesChannel: string;
  onChange: (patch: Partial<CustomerOrderLinkValue>) => void;
}) {
  const customerStore = useCustomers();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { customerStore.loadCustomers({ pageSize: 5000 }); }, [customerStore.loadCustomers]);

  useEffect(() => {
    let alive = true;
    if (!value.customerId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    customerStore.getCustomer(value.customerId)
      .then(result => { if (alive) setDetail(result); })
      .catch(() => { if (alive) setDetail(null); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [customerStore.getCustomer, value.customerId]);

  const customerOptions = useMemo(() => customerStore.customers.map(customer => ({
    label: customer.displayName,
    value: customer._id,
  })), [customerStore.customers]);

  const activeAliases = useMemo(() => (detail?.aliases || []).filter(alias => alias.enabled !== false), [detail]);
  const activeRecipients = useMemo(() => (detail?.recipients || []).filter(recipient => recipient.enabled !== false), [detail]);

  const selectCustomer = async (rawValue: unknown) => {
    const customerId = String(rawValue || '');
    if (!customerId) {
      setDetail(null);
      onChange({ customerId: '', customerAliasId: '', recipientProfileId: '' });
      return;
    }
    setDetailLoading(true);
    try {
      const selected = await customerStore.getCustomer(customerId);
      setDetail(selected);
      const alias = selected.aliases.find(item => item.enabled !== false && item.salesChannel === salesChannel)
        || selected.aliases.find(item => item.enabled !== false && !item.salesChannel)
        || selected.aliases.find(item => item.enabled !== false);
      onChange({
        customerId,
        customerAliasId: alias?._id || '',
        recipientProfileId: '',
        customerName: alias?.name || selected.displayName,
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const selectAlias = (rawValue: unknown) => {
    const aliasId = String(rawValue || '');
    const alias = activeAliases.find(item => item._id === aliasId);
    onChange({ customerAliasId: aliasId, ...(alias ? { customerName: alias.name } : {}) });
  };

  const selectRecipient = (rawValue: unknown) => {
    const recipientProfileId = String(rawValue || '');
    const recipient = activeRecipients.find(item => item._id === recipientProfileId);
    onChange({
      recipientProfileId,
      ...(recipient ? {
        consignee: recipient.consignee,
        consigneePhone: recipient.phone,
        consigneeAddress: recipient.address,
      } : {}),
    });
  };

  return (
    <div className="col-span-2 rounded-lg border border-blue-100 bg-blue-50/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-blue-700">关联客户主档案（可选）</div>
          <div className="text-xs text-gray-400">不选择也能保存；选择后可复用别名与收货档案</div>
        </div>
        {value.customerId && <Button size="small" variant="text" onClick={() => onChange({ customerId: '', customerAliasId: '', recipientProfileId: '' })}>解除关联</Button>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500">客户主档案</label>
          <Select clearable filterable loading={customerStore.loading} placeholder="搜索并选择客户" value={value.customerId || undefined} options={customerOptions} onChange={selectCustomer} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">下单别名</label>
          <Select clearable filterable disabled={!value.customerId || detailLoading} placeholder="选择客户别名" value={value.customerAliasId || undefined} options={activeAliases.map(alias => ({ label: alias.salesChannel ? `${alias.name}（${alias.salesChannel}）` : alias.name, value: alias._id }))} onChange={selectAlias} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">收货档案</label>
          <Select clearable filterable disabled={!value.customerId || detailLoading} placeholder="可提前带入收货信息" value={value.recipientProfileId || undefined} options={activeRecipients.map(recipient => ({ label: `${recipient.label} · ${recipient.consignee} · ${recipient.phone}`, value: recipient._id }))} onChange={selectRecipient} />
        </div>
      </div>
    </div>
  );
}
