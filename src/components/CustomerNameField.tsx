import { useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog } from 'tdesign-react';
import { ChevronDown, Check, Search, X } from 'lucide-react';
import { useCustomers } from '../hooks/useCustomers';
import { usePermission } from '../contexts/PermissionContext';
import type { CustomerOrderSelection, CustomerSuggestion } from '../types';
import { CustomerOrderLinkFields, type CustomerOrderLinkValue } from './CustomerOrderLinkFields';

type Alias = CustomerOrderSelection['aliases'][number];
type Recipient = CustomerOrderSelection['recipients'][number];

export function CustomerNameField({ value, salesChannel, onChange }: {
  value: CustomerOrderLinkValue; salesChannel: string; onChange: (patch: Partial<CustomerOrderLinkValue>) => void;
}) {
  const { suggestCustomers, getOrderSelection } = useCustomers();
  const { can } = usePermission();
  const canSelect = ['customers:read', 'customers:write', 'customers:merge', 'orders:create', 'orders:update'].some(can);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<CustomerSuggestion[]>([]);
  const [linked, setLinked] = useState<{ id: string; name: string } | null>(null);
  const [more, setMore] = useState(false);
  const [addressTarget, setAddressTarget] = useState<CustomerSuggestion | null>(null);
  const [addressPage, setAddressPage] = useState(1);
  const [addressData, setAddressData] = useState<CustomerOrderSelection | null>(null);
  const [addressError, setAddressError] = useState('');
  const [addressLoading, setAddressLoading] = useState(false);
  const [pendingAddress, setPendingAddress] = useState<{ customer: CustomerSuggestion; recipient: Recipient } | null>(null);
  const cache = useRef(new Map<string, { at: number; rows: CustomerSuggestion[] }>());

  useEffect(() => {
    let alive = true;
    setResults([]); setError(''); setLoading(false);
    const keyword = value.customerName.trim();
    if (!open || !canSelect || composing || !keyword) return;
    const key = `${salesChannel}\n${keyword}`;
    const cached = cache.current.get(key);
    if (cached && Date.now() - cached.at < 15000) { setResults(cached.rows); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      suggestCustomers(keyword, salesChannel).then(rows => {
        if (!alive) return;
        if (cache.current.size >= 20) cache.current.clear();
        cache.current.set(key, { at: Date.now(), rows }); setResults(rows);
      }).catch(() => { if (alive) setError('推荐暂不可用，可继续手动填写'); })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [open, canSelect, composing, value.customerName, salesChannel, suggestCustomers]);

  useEffect(() => {
    let alive = true;
    if (!value.customerId || !canSelect || linked?.id === value.customerId) return;
    getOrderSelection(value.customerId).then(detail => {
      if (alive) setLinked({ id: detail._id, name: detail.displayName });
    }).catch(() => { if (alive) setLinked({ id: value.customerId, name: '原客户（资料暂不可用）' }); });
    return () => { alive = false; };
  }, [value.customerId, canSelect, linked?.id, getOrderSelection]);

  useEffect(() => {
    let alive = true;
    setAddressData(null); setAddressError('');
    if (!addressTarget) return;
    setAddressLoading(true);
    getOrderSelection(addressTarget._id, 1, addressPage).then(data => { if (alive) setAddressData(data); })
      .catch(() => { if (alive) setAddressError('地址加载失败，请关闭后重试'); })
      .finally(() => { if (alive) setAddressLoading(false); });
    return () => { alive = false; };
  }, [addressTarget, addressPage, getOrderSelection]);

  const recipientPatch = (recipient: Recipient) => ({
    recipientProfileId: recipient._id, consignee: recipient.consignee,
    consigneePhone: recipient.phone, consigneeAddress: recipient.address,
  });
  const needsAddressConfirmation = (recipient: Recipient) =>
    [[value.consignee, recipient.consignee], [value.consigneePhone, recipient.phone], [value.consigneeAddress, recipient.address]]
      .some(([current, next]) => current.trim() && current !== next);
  const select = (customer: CustomerSuggestion, alias?: Alias) => {
    const recipient = customer.recipients[0];
    const confirmAddress = recipient && needsAddressConfirmation(recipient);
    setLinked({ id: customer._id, name: customer.displayName }); setOpen(false);
    onChange({ customerSelectionMode: 'explicit', customerId: customer._id, customerAliasId: alias?._id || '',
      customerName: alias?.name || customer.displayName,
      recipientProfileId: customer._id === value.customerId ? value.recipientProfileId : '',
      ...(recipient && !confirmAddress ? recipientPatch(recipient) : {}) });
    if (recipient && confirmAddress) setPendingAddress({ customer, recipient });
  };
  const applyAddress = (customer: CustomerSuggestion, recipient: Recipient) => {
    const same = value.customerId === customer._id;
    setLinked({ id: customer._id, name: customer.displayName }); setOpen(false); setAddressTarget(null); setPendingAddress(null);
    onChange({ customerSelectionMode: 'explicit', customerId: customer._id,
      ...(same ? {} : { customerName: customer.displayName, customerAliasId: '' }),
      ...recipientPatch(recipient) });
  };
  const useAddress = (customer: CustomerSuggestion, recipient: Recipient) => {
    if (needsAddressConfirmation(recipient)) setPendingAddress({ customer, recipient }); else applyAddress(customer, recipient);
  };
  const show = open && canSelect && !!value.customerName.trim() && !composing;

  return <div ref={root} className="relative" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { input.current?.focus(); setOpen(false); }
    if (event.key === 'ArrowDown' && event.target === input.current && show) {
      const first = root.current?.querySelector<HTMLButtonElement>('[data-customer-option]');
      if (first) { event.preventDefault(); first.focus(); }
    }
  }}>
    <label htmlFor={id} className="block text-xs text-gray-500 mb-1">客户名称 <span className="text-red-500">*</span></label>
    <div className="relative">
      <input ref={input} id={id} value={value.customerName} autoComplete="off" maxLength={100}
        aria-required="true" aria-expanded={show} aria-controls={`${id}-suggestions`} aria-describedby={`${id}-hint`}
        placeholder="输入客户名称，可选择已有客户"
        className="w-full h-10 pl-3 pr-9 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        onFocus={() => setOpen(true)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onChange={event => { setOpen(true); onChange({ customerName: event.target.value, customerAliasId: '' }); }} />
      <Search aria-hidden size={16} className="absolute right-3 top-3 text-gray-400 pointer-events-none" />
    </div>
    <div id={`${id}-hint`} className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-gray-500">
      {value.customerId ? <><Check size={13} className="text-green-600" /><span>已关联：{linked?.id === value.customerId ? linked.name : '加载中…'}</span>
        {canSelect && <button type="button" className="ml-1 text-blue-600 hover:underline" onClick={() => {
          onChange({ customerSelectionMode: 'none', customerId: '', customerAliasId: '', recipientProfileId: '' }); setOpen(false);
        }}>取消关联</button>}</> : <span>可直接填写，选择推荐后关联客户</span>}
      {canSelect && <button type="button" className="ml-auto inline-flex items-center text-gray-500 hover:text-blue-600" onClick={() => { setOpen(false); setMore(true); }}>更多操作<ChevronDown size={12} /></button>}
    </div>
    {show && <div id={`${id}-suggestions`} role="region" aria-label="客户推荐" className="mt-2 w-full min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex justify-between items-center px-3 py-2 bg-gray-50 text-xs text-gray-500"><span>推荐客户 · 最多 3 位</span><button type="button" aria-label="关闭推荐" onClick={() => setOpen(false)}><X size={14} /></button></div>
      <div aria-live="polite">
        {loading ? <p className="p-3 text-sm text-gray-500">正在查找客户…</p> : error ? <p className="p-3 text-sm text-gray-500">{error}</p> : !results.length ? <p className="p-3 text-sm text-gray-500">未找到匹配客户，可继续使用当前名称</p> : results.map(customer => <div key={customer._id} className="px-3 py-3 border-t first:border-t-0 border-gray-100">
          <button type="button" data-customer-option className="w-full flex items-start justify-between gap-2 text-left hover:text-blue-600 focus-visible:outline-blue-500" onClick={() => select(customer)}>
            <span className="font-medium text-sm break-all">{customer.displayName}</span><span className="text-xs text-blue-600 shrink-0">选用客户</span>
          </button>
          <div className="flex flex-wrap gap-1 mt-1 text-xs text-gray-500"><span>别名：</span>{customer.aliases.length ? customer.aliases.map(alias => <button key={alias._id} type="button" className="text-blue-600 hover:underline break-all" onClick={() => select(customer, alias)}>{alias.name}{alias.salesChannel ? `（${alias.salesChannel}）` : ''}</button>) : <span>暂无</span>}</div>
          {customer.recipients[0] ? <div className="mt-2 text-xs text-gray-500 space-y-1">
            <div>{customer.recipients[0].consignee} · {customer.recipients[0].phone}</div>
            <div className="break-words line-clamp-2" title={customer.recipients[0].address}>{customer.recipients[0].address || '未填写地址'}</div>
            <button type="button" className="text-blue-600 hover:underline" onClick={() => useAddress(customer, customer.recipients[0])}>使用此地址</button>
            {customer.recipientTotal > 1 && <button type="button" className="ml-3 text-blue-600 hover:underline" onClick={() => { setAddressTarget(customer); setAddressPage(1); setOpen(false); }}>另有 {customer.recipientTotal - 1} 个地址</button>}
          </div> : <div className="mt-2 text-xs text-gray-400">暂无收货地址</div>}
        </div>)}
      </div>
      <button type="button" className="w-full border-t border-gray-100 py-2 text-xs text-gray-500 hover:bg-gray-50" onClick={() => setOpen(false)}>继续使用输入名称</button>
    </div>}
    {/* 订单 Dialog 的默认层级为 2500，客户子弹窗需要显示在其上方。 */}
    <Dialog visible={more} zIndex={3000} header="更多客户操作" footer={false} onClose={() => { setMore(false); cache.current.clear(); }} width={760}>
      {more && <CustomerOrderLinkFields value={value} salesChannel={salesChannel} onChange={patch => { setLinked(null); onChange(patch); }} />}
    </Dialog>
    <Dialog visible={!!addressTarget && !pendingAddress} zIndex={3000} header={`${addressTarget?.displayName || ''}的收货地址`} footer={false} onClose={() => setAddressTarget(null)} width={560}>
      {addressLoading ? <p>正在加载地址…</p> : addressError ? <p role="alert">{addressError}</p> : <div className="space-y-3">
        {addressData?.recipients.map(recipient => <div key={recipient._id} className="rounded-lg border border-gray-200 p-3 text-sm">
          <div className="font-medium">{recipient.label} · {recipient.consignee} · {recipient.phone}</div>
          <p className="my-2 break-words text-gray-500">{recipient.address}</p>
          <Button size="small" variant="outline" onClick={() => addressTarget && useAddress(addressTarget, recipient)}>使用此地址</Button>
        </div>)}
        <div className="flex justify-between"><Button variant="text" disabled={addressPage <= 1} onClick={() => setAddressPage(page => page - 1)}>上一页</Button>
          <Button variant="text" disabled={!addressData || addressPage * addressData.pageSize >= addressData.recipientTotal} onClick={() => setAddressPage(page => page + 1)}>下一页</Button></div>
      </div>}
    </Dialog>
    <Dialog visible={!!pendingAddress} zIndex={3100} header="替换本次订单收件信息？" confirmBtn="使用所选地址" cancelBtn="保留原收件信息" onConfirm={() => pendingAddress && applyAddress(pendingAddress.customer, pendingAddress.recipient)} onClose={() => setPendingAddress(null)}>
      <p className="text-sm text-gray-500">本次订单已填写收件信息。确认后将替换为以下地址，客户主档案不受影响。</p>
      <p className="mt-3">{pendingAddress?.recipient.consignee} · {pendingAddress?.recipient.phone}</p><p className="mt-2 break-words">{pendingAddress?.recipient.address}</p>
    </Dialog>
  </div>;
}
