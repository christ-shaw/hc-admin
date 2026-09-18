import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select } from 'tdesign-react';
import type { CustomerOrderSelection, CustomerSelectionItem } from '../types';
import { useCustomers } from '../hooks/useCustomers';
import { usePermission } from '../contexts/PermissionContext';

export interface CustomerOrderLinkValue {
  customerSelectionMode?: 'explicit' | 'none';
  customerId: string;
  customerAliasId: string;
  recipientProfileId: string;
  customerName: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddress: string;
}

function PageButtons({ page, total, disabled, onChange }: {
  page: number; total: number; disabled: boolean; onChange: (page: number) => void;
}) {
  if (total <= 20) return null;
  return <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
    <Button size="small" variant="text" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
    <span>{page} / {Math.ceil(total / 20)}</span>
    <Button size="small" variant="text" disabled={disabled || page * 20 >= total} onClick={() => onChange(page + 1)}>下一页</Button>
  </div>;
}

export function CustomerOrderLinkFields({ value, salesChannel, onChange, readOnly = false }: {
  readOnly?: boolean;
  value: CustomerOrderLinkValue;
  salesChannel: string;
  onChange: (patch: Partial<CustomerOrderLinkValue>) => void;
}) {
  const { searchCustomers, getOrderSelection, mutate } = useCustomers();
  const { can } = usePermission();
  const canSelect = ['customers:read', 'customers:write', 'customers:merge', 'orders:create', 'orders:update'].some(can);
  const [keyword, setKeyword] = useState('');
  const [searchPage, setSearchPage] = useState(1);
  const [results, setResults] = useState<CustomerSelectionItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [detail, setDetail] = useState<CustomerOrderSelection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [aliasPage, setAliasPage] = useState(1);
  const [recipientPage, setRecipientPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [writeMode, setWriteMode] = useState<'create' | 'alias' | 'recipient' | null>(null);
  const [writeName, setWriteName] = useState('');
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    let alive = true;
    setResults([]);
    setSearchTotal(0);
    setSearchError('');
    if (!canSelect || !keyword.trim()) { setSearchLoading(false); return; }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      searchCustomers(keyword.trim(), searchPage)
        .then(result => { if (alive) { setResults(result.data); setSearchTotal(result.total); } })
        .catch(error => { if (alive) setSearchError(error instanceof Error ? error.message : '搜索客户失败'); })
        .finally(() => { if (alive) setSearchLoading(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [canSelect, keyword, searchPage, searchCustomers, retry]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError('');
    if (!canSelect || !value.customerId) { setDetailLoading(false); return; }
    setDetailLoading(true);
    getOrderSelection(value.customerId, aliasPage, recipientPage)
      .then(result => { if (alive) setDetail(result); })
      .catch(error => { if (alive) setDetailError(error instanceof Error ? error.message : '加载客户资料失败'); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [canSelect, getOrderSelection, value.customerId, aliasPage, recipientPage, retry]);

  const customerOptions = useMemo(() => {
    const options = results.map(customer => ({ label: customer.displayName, value: customer._id }));
    if (value.customerId && !options.some(option => option.value === value.customerId)) {
      options.unshift({ label: detail?.displayName || value.customerName || '已关联客户', value: value.customerId });
    }
    return options;
  }, [results, detail, value.customerId, value.customerName]);

  const selectCustomer = (rawValue: unknown) => {
    const customerId = String(rawValue || '');
    if (customerId === value.customerId) return;
    setDetail(null);
    setAliasPage(1);
    setRecipientPage(1);
    const selected = results.find(customer => customer._id === customerId);
    onChange({ customerSelectionMode: customerId ? 'explicit' : 'none', customerId, customerAliasId: '', recipientProfileId: '', ...(selected ? { customerName: selected.displayName } : {}) });
  };

  const aliasOptions = (detail?.aliases || []).map(alias => ({
    label: `${alias.name}${alias.salesChannel ? `（${alias.salesChannel}）` : ''}${alias.salesChannel === salesChannel && salesChannel ? ' · 当前渠道' : ''}`,
    value: alias._id,
  }));
  if (value.customerAliasId && !aliasOptions.some(option => option.value === value.customerAliasId)) {
    aliasOptions.unshift({ label: `${value.customerName}（原订单别名）`, value: value.customerAliasId });
  }
  const recipientOptions = (detail?.recipients || []).map(recipient => ({
    label: `${recipient.label} · ${recipient.consignee} · ${recipient.phone}`, value: recipient._id,
  }));
  if (value.recipientProfileId && !recipientOptions.some(option => option.value === value.recipientProfileId)) {
    recipientOptions.unshift({ label: `${value.consignee}（原订单收件档案）`, value: value.recipientProfileId });
  }

  const saveArchive = async () => {
    if (!writeMode || writing) return;
    setWriting(true);
    try {
      if (writeMode === 'create') {
        const saved = await mutate('create', { displayName: writeName.trim() });
        if (!saved?._id) throw new Error('建档结果缺少客户 ID');
        onChange({ customerId: saved._id, customerAliasId: saved.primaryAliasId || '', recipientProfileId: '',
          customerName: writeName.trim(), customerSelectionMode: 'explicit' });
        setAliasPage(1); setRecipientPage(1);
      } else if (writeMode === 'alias') {
        const saved = await mutate('createAlias', { customerId: value.customerId, name: writeName.trim(), salesChannel, sourceType: 'order' });
        if (!saved?._id) throw new Error('保存结果缺少别名 ID');
        onChange({ customerAliasId: saved._id, customerName: writeName.trim(), customerSelectionMode: 'explicit' });
      } else {
        const saved = await mutate('createRecipient', { customerId: value.customerId, consignee: value.consignee,
          phone: value.consigneePhone, address: value.consigneeAddress, sourceType: 'order' });
        if (!saved?._id) throw new Error('保存结果缺少档案 ID');
        onChange({ recipientProfileId: saved._id, customerSelectionMode: 'explicit' });
      }
      setRetry(previous => previous + 1); setWriteMode(null);
      MessagePlugin.success('客户资料已保存');
    } catch (error) { MessagePlugin.error(error instanceof Error ? error.message : '保存失败，请重试'); }
    finally { setWriting(false); }
  };

  if (!canSelect) return null;
  if (readOnly) return <div className="col-span-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-700">
    客户主档案：{value.customerId ? (detail?.displayName || value.customerName || '已关联客户') : '未关联'}
    <div className="mt-1 text-xs text-gray-500">普通编辑保留当前客户归属及关联时间。修改本次收件信息只影响订单快照。</div>
  </div>;

  return (
    <div className="col-span-2 rounded-lg border border-blue-100 bg-blue-50/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-blue-700">关联客户主档案（可选）</div>
          <div className="text-xs text-gray-400">不选择也能保存；选择后可复用别名与收货档案</div>
        </div>
        {value.customerId && <Button size="small" variant="text" onClick={() => selectCustomer('')}>清除本次选择</Button>}
      </div>
      <div className="mb-2">
        <Input aria-label="搜索客户" clearable value={keyword} placeholder="输入主名称、别名、电话或地址搜索客户"
          onChange={text => { setKeyword(String(text)); setSearchPage(1); }} />
        {keyword.trim() && !searchLoading && !searchError && <div className="mt-1 text-xs text-gray-500">找到 {searchTotal} 个客户</div>}
        <PageButtons page={searchPage} total={searchTotal} disabled={searchLoading} onChange={setSearchPage} />
      </div>
      {(searchError || detailError) && <div role="alert" className="mb-2 text-sm text-red-600">
        {searchError || detailError}<Button size="small" variant="text" onClick={() => setRetry(previous => previous + 1)}>重试</Button>
      </div>}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500">客户主档案</label>
          <Select clearable loading={searchLoading} placeholder="从搜索结果选择客户" value={value.customerId || undefined} options={customerOptions} onChange={selectCustomer} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">下单别名</label>
          <Select clearable disabled={!detail || detailLoading} placeholder="选择客户别名" value={value.customerAliasId || undefined} options={aliasOptions}
            onChange={raw => {
              const aliasId = String(raw || '');
              const alias = detail?.aliases.find(item => item._id === aliasId);
              onChange({ customerSelectionMode: 'explicit', customerAliasId: aliasId, ...(alias ? { customerName: alias.name } : {}) });
            }} />
          <PageButtons page={aliasPage} total={detail?.aliasTotal || 0} disabled={detailLoading} onChange={setAliasPage} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">收货档案</label>
          <Select clearable disabled={!detail || detailLoading} placeholder="可提前带入收货信息" value={value.recipientProfileId || undefined} options={recipientOptions}
            onChange={raw => {
              const recipientProfileId = String(raw || '');
              const recipient = detail?.recipients.find(item => item._id === recipientProfileId);
              onChange({ customerSelectionMode: 'explicit', recipientProfileId, ...(recipient ? {
                consignee: recipient.consignee, consigneePhone: recipient.phone, consigneeAddress: recipient.address,
              } : {}) });
            }} />
          <PageButtons page={recipientPage} total={detail?.recipientTotal || 0} disabled={detailLoading} onChange={setRecipientPage} />
        </div>
      </div>
      {can('customers:write') && <div className="mt-3 flex flex-wrap gap-2">
        <Button size="small" variant="outline" onClick={() => { setWriteName(value.customerName); setWriteMode('create'); }}>快捷新建客户</Button>
        <Button size="small" variant="outline" disabled={!detail || detailLoading} onClick={() => { setWriteName(value.customerName); setWriteMode('alias'); }}>将名称保存为别名</Button>
        <Button size="small" variant="outline" disabled={!detail || detailLoading || !value.consignee || !value.consigneePhone || !value.consigneeAddress}
          onClick={() => setWriteMode('recipient')}>将收件信息保存为档案</Button>
      </div>}
      <div className="mt-2 text-xs text-gray-500">本次临时修改收件信息不会更新客户档案。填写收件信息后，可返回此步骤单独保存档案。</div>
      <Dialog visible={!!writeMode} zIndex={3100} header={writeMode === 'create' ? '快捷新建客户' : writeMode === 'alias' ? '保存客户别名' : '保存收货档案'}
        onClose={() => { if (!writing) setWriteMode(null); }} onConfirm={saveArchive}
        confirmBtn={{ content: '确认保存客户资料', loading: writing }} cancelBtn={{ content: '取消', disabled: writing }}>
        <div className="space-y-3">
          <p className="text-sm text-gray-500">此次确认会单独保存客户资料；取消录单也会保留已保存的资料。</p>
          {writeMode !== 'create' && <p>所属客户：{detail?.displayName || value.customerName}</p>}
          {writeMode === 'recipient' ? <div className="space-y-2 break-words">
            <p>收件人：{value.consignee}</p><p>电话：{value.consigneePhone}</p><p>地址：{value.consigneeAddress}</p>
          </div> : <Input aria-label={writeMode === 'create' ? '客户主名称' : '客户别名'} value={writeName} disabled={writing} onChange={text => setWriteName(String(text))} />}
          {writeMode === 'alias' && <p className="text-sm">渠道：{salesChannel || '未指定'}</p>}
        </div>
      </Dialog>
    </div>
  );
}
