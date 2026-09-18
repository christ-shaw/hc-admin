import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Pagination, Switch, Table, Tag, Textarea } from 'tdesign-react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import type { CustomerAliasRecord, CustomerDetail, CustomerRecipientProfileRecord } from '../types';
import { useCustomers, type CustomerListItem } from '../hooks/useCustomers';
import { CustomerArchive } from '../components/CustomerArchive';
import { usePermission } from '../contexts/PermissionContext';

const EMPTY_CUSTOMER = { displayName: '', remark: '' };
const EMPTY_ALIAS = { name: '', salesChannel: '', remark: '' };
const EMPTY_RECIPIENT = { label: '', consignee: '', phone: '', address: '' };

export function Customers() {
  const customerStore = useCustomers();
  const [activeTab, setActiveTab] = useState<'customers' | 'archive'>('customers');
  const { can } = usePermission();
  const canWrite = can('customers:write');
  const [keyword, setKeyword] = useState('');
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [page, setPage] = useState(1);
  const [customerVisible, setCustomerVisible] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerListItem | null>(null);
  const [customerForm, setCustomerForm] = useState(EMPTY_CUSTOMER);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [aliasVisible, setAliasVisible] = useState(false);
  const [editingAlias, setEditingAlias] = useState<CustomerAliasRecord | null>(null);
  const [aliasForm, setAliasForm] = useState(EMPTY_ALIAS);
  const [recipientVisible, setRecipientVisible] = useState(false);
  const [editingRecipient, setEditingRecipient] = useState<CustomerRecipientProfileRecord | null>(null);
  const [recipientForm, setRecipientForm] = useState(EMPTY_RECIPIENT);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => customerStore.loadCustomers({ keyword, includeDisabled, page }), [customerStore.loadCustomers, keyword, includeDisabled, page]);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (customerId: string) => {
    setDetailVisible(true);
    setDetailLoading(true);
    try {
      setDetail(await customerStore.getCustomer(customerId));
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : '加载客户详情失败');
      setDetailVisible(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async () => {
    if (!detail?._id) return;
    setDetail(await customerStore.getCustomer(detail._id));
  };

  const runMutation = async (action: string, data: Record<string, unknown>, successMessage: string, after?: () => void) => {
    setSaving(true);
    try {
      await customerStore.mutate(action, data);
      MessagePlugin.success(successMessage);
      after?.();
      await load();
      if (detail?._id && action !== 'disable' && action !== 'enable') await refreshDetail();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setEditingCustomer(null);
    setCustomerForm(EMPTY_CUSTOMER);
    setCustomerVisible(true);
  };

  const openEdit = (row: CustomerListItem) => {
    setEditingCustomer(row);
    setCustomerForm({ displayName: row.displayName, remark: row.remark || '' });
    setCustomerVisible(true);
  };

  const saveCustomer = () => {
    if (!customerForm.displayName.trim()) return void MessagePlugin.warning('请填写客户主名称');
    runMutation(editingCustomer ? 'update' : 'create', {
      customerId: editingCustomer?._id,
      displayName: customerForm.displayName.trim(),
      remark: customerForm.remark.trim(),
    }, editingCustomer ? '客户主档案已更新' : '客户主档案已创建', () => setCustomerVisible(false));
  };

  const openAlias = (alias?: CustomerAliasRecord) => {
    setEditingAlias(alias || null);
    setAliasForm(alias ? { name: alias.name, salesChannel: alias.salesChannel || '', remark: alias.remark || '' } : EMPTY_ALIAS);
    setAliasVisible(true);
  };

  const saveAlias = () => {
    if (!detail || !aliasForm.name.trim()) return void MessagePlugin.warning('请填写客户别名');
    runMutation(editingAlias ? 'updateAlias' : 'createAlias', {
      customerId: detail._id,
      aliasId: editingAlias?._id,
      ...aliasForm,
    }, editingAlias ? '客户别名已更新' : '客户别名已添加', () => setAliasVisible(false));
  };

  const openRecipient = (recipient?: CustomerRecipientProfileRecord) => {
    setEditingRecipient(recipient || null);
    setRecipientForm(recipient ? {
      label: recipient.label,
      consignee: recipient.consignee,
      phone: recipient.phone,
      address: recipient.address,
    } : EMPTY_RECIPIENT);
    setRecipientVisible(true);
  };

  const saveRecipient = () => {
    if (!detail || !recipientForm.consignee.trim() || !recipientForm.phone.trim() || !recipientForm.address.trim()) {
      return void MessagePlugin.warning('请完整填写收货人、电话和地址');
    }
    runMutation(editingRecipient ? 'updateRecipient' : 'createRecipient', {
      customerId: detail._id,
      recipientId: editingRecipient?._id,
      ...recipientForm,
    }, editingRecipient ? '收货档案已更新' : '收货档案已添加', () => setRecipientVisible(false));
  };

  const columns = useMemo(() => [
    { colKey: 'displayName', title: '客户主名称', width: 200, ellipsis: true },
    { colKey: 'aliasCount', title: '有效别名', width: 90 },
    { colKey: 'recipientCount', title: '收货档案', width: 90 },
    {
      colKey: 'status', title: '状态', width: 90,
      cell: ({ row }: { row: CustomerListItem }) => <Tag theme={row.status === 'active' ? 'success' : 'default'}>{row.status === 'active' ? '启用' : '停用'}</Tag>,
    },
    { colKey: 'remark', title: '备注', ellipsis: true },
    { colKey: 'updatedAt', title: '最近更新', width: 180, cell: ({ row }: { row: CustomerListItem }) => row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '-' },
    {
      colKey: 'op', title: '操作', width: canWrite ? 220 : 80, fixed: 'right' as const,
      cell: ({ row }: { row: CustomerListItem }) => (
        <div className="flex gap-1">
          <Button size="small" variant="text" theme="primary" onClick={() => openDetail(row._id)}>详情</Button>
          {canWrite && <Button size="small" variant="text" onClick={() => openEdit(row)}>编辑</Button>}
          {canWrite && <Button size="small" variant="text" theme={row.status === 'active' ? 'danger' : 'primary'} onClick={() => runMutation(row.status === 'active' ? 'disable' : 'enable', { customerId: row._id }, row.status === 'active' ? '客户已停用' : '客户已启用')}>{row.status === 'active' ? '停用' : '启用'}</Button>}
        </div>
      ),
    },
  ], [canWrite, detail?._id, keyword, includeDisabled, page]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">客户管理</h1>
          <p className="mt-1 text-gray-500">统一维护租赁 1 / 租赁 2 客户、别名和多个收货档案</p>
        </div>
        {canWrite && activeTab === 'customers' && <Button theme="primary" icon={<Plus size={16} />} onClick={openCreate}>新增客户</Button>}
      </div>

      <div className="flex gap-2" role="tablist" aria-label="客户管理视图"><Button role="tab" aria-selected={activeTab === 'customers'} variant={activeTab === 'customers' ? 'base' : 'text'} onClick={() => setActiveTab('customers')}>客户列表</Button><Button role="tab" aria-selected={activeTab === 'archive'} variant={activeTab === 'archive' ? 'base' : 'text'} onClick={() => setActiveTab('archive')}>待归档</Button></div>
      {activeTab === 'archive' && <CustomerArchive onChanged={load} />}
      <div hidden={activeTab !== 'customers'}>
      <div className="glass-card p-4">
        <div className="mb-4 flex items-center gap-3">
          <Input className="max-w-md" value={keyword} placeholder="搜索主名称、别名、收货人、电话或地址" prefixIcon={<Search size={16} />} onChange={value => { setKeyword(value as string); setPage(1); }} onEnter={load} />
          <Button variant="outline" icon={<Search size={16} />} onClick={load}>查询</Button>
          <Button variant="text" icon={<RefreshCw size={16} />} onClick={() => { setKeyword(''); setPage(1); customerStore.loadCustomers({ keyword: '', includeDisabled, page: 1 }); }}>重置</Button>
          <label className="ml-auto flex items-center gap-2 text-sm text-gray-500">显示停用 <Switch value={includeDisabled} onChange={value => { setIncludeDisabled(!!value); setPage(1); }} /></label>
        </div>
        {customerStore.loadError && <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{customerStore.loadError}</div>}
        <Table data={customerStore.customers} columns={columns} loading={customerStore.loading} rowKey="_id" tableLayout="fixed" hover stripe />
        <div className="border-t border-gray-100 py-3"><Pagination current={page} pageSize={20} total={customerStore.total} showPageSize={false} onCurrentChange={setPage} /></div>
      </div>

      <Dialog header={editingCustomer ? '编辑客户主档案' : '新增客户主档案'} visible={customerVisible} width="560px" onClose={() => setCustomerVisible(false)} footer={<div className="flex justify-end gap-2"><Button onClick={() => setCustomerVisible(false)}>取消</Button><Button theme="primary" loading={saving} onClick={saveCustomer}>保存</Button></div>}>
        <div className="space-y-4">
          <div><label className="mb-1 block text-sm text-gray-600">客户主名称 <span className="text-red-500">*</span></label><Input value={customerForm.displayName} onChange={value => setCustomerForm(prev => ({ ...prev, displayName: value as string }))} /></div>
          <div><label className="mb-1 block text-sm text-gray-600">备注</label><Textarea value={customerForm.remark} onChange={value => setCustomerForm(prev => ({ ...prev, remark: value as string }))} autosize={{ minRows: 3, maxRows: 6 }} /></div>
        </div>
      </Dialog>

      <Dialog header={detail ? `客户详情 · ${detail.displayName}` : '客户详情'} visible={detailVisible} width="900px" onClose={() => setDetailVisible(false)} footer={false}>
        {detailLoading || !detail ? <div className="py-16 text-center text-gray-400">正在加载...</div> : (
          <div className="max-h-[70vh] space-y-6 overflow-auto pr-2">
            <div className="grid grid-cols-3 gap-3 rounded-lg bg-gray-50 p-4 text-sm"><div><span className="text-gray-400">主名称：</span>{detail.displayName}</div><div><span className="text-gray-400">关联订单：</span>{detail.linkedOrderCount}</div><div><span className="text-gray-400">状态：</span>{detail.status === 'active' ? '启用' : '停用'}</div><div className="col-span-3"><span className="text-gray-400">备注：</span>{detail.remark || '-'}</div></div>

            <section>
              <div className="mb-2 flex items-center justify-between"><h3 className="font-medium text-gray-700">客户别名</h3>{canWrite && <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={() => openAlias()}>添加别名</Button>}</div>
              <Table rowKey="_id" size="small" data={detail.aliases} columns={[
                { colKey: 'name', title: '别名' }, { colKey: 'salesChannel', title: '渠道', width: 140, cell: ({ row }: { row: CustomerAliasRecord }) => row.salesChannel || '不限' }, { colKey: 'remark', title: '说明', ellipsis: true }, { colKey: 'enabled', title: '状态', width: 70, cell: ({ row }: { row: CustomerAliasRecord }) => row.enabled !== false ? '启用' : '停用' },
                ...(canWrite ? [{ colKey: 'op', title: '操作', width: 130, cell: ({ row }: { row: CustomerAliasRecord }) => <div className="flex gap-1"><Button variant="text" size="small" onClick={() => openAlias(row)}>编辑</Button>{row.enabled !== false && <Button variant="text" theme="danger" size="small" onClick={() => runMutation('disableAlias', { aliasId: row._id }, '别名已停用')}>停用</Button>}</div> }] : []),
              ]} />
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between"><h3 className="font-medium text-gray-700">收货档案</h3>{canWrite && <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={() => openRecipient()}>添加收货档案</Button>}</div>
              <Table rowKey="_id" size="small" data={detail.recipients} columns={[
                { colKey: 'label', title: '标签', width: 120 }, { colKey: 'consignee', title: '收货人', width: 100 }, { colKey: 'phone', title: '电话', width: 140 }, { colKey: 'address', title: '地址', ellipsis: true }, { colKey: 'enabled', title: '状态', width: 70, cell: ({ row }: { row: CustomerRecipientProfileRecord }) => row.enabled !== false ? '启用' : '停用' },
                ...(canWrite ? [{ colKey: 'op', title: '操作', width: 130, cell: ({ row }: { row: CustomerRecipientProfileRecord }) => <div className="flex gap-1"><Button variant="text" size="small" onClick={() => openRecipient(row)}>编辑</Button>{row.enabled !== false && <Button variant="text" theme="danger" size="small" onClick={() => runMutation('disableRecipient', { recipientId: row._id }, '收货档案已停用')}>停用</Button>}</div> }] : []),
              ]} />
            </section>

            <section><h3 className="mb-2 font-medium text-gray-700">最近关联订单</h3><Table rowKey="_id" size="small" data={detail.recentOrders} columns={[{ colKey: 'serialNumber', title: '序号', width: 90 }, { colKey: 'date', title: '日期', width: 110 }, { colKey: 'customerName', title: '下单名称', width: 160 }, { colKey: 'consignee', title: '收货人', width: 120 }, { colKey: 'onlineOrderNumber', title: '网店订单号' }]} /></section>
          </div>
        )}
      </Dialog>

      <Dialog header={editingAlias ? '编辑客户别名' : '添加客户别名'} visible={aliasVisible} width="520px" onClose={() => setAliasVisible(false)} footer={<div className="flex justify-end gap-2"><Button onClick={() => setAliasVisible(false)}>取消</Button><Button theme="primary" loading={saving} onClick={saveAlias}>保存</Button></div>}>
        <div className="space-y-3"><div><label className="mb-1 block text-sm text-gray-600">别名 <span className="text-red-500">*</span></label><Input value={aliasForm.name} onChange={value => setAliasForm(prev => ({ ...prev, name: value as string }))} /></div><div><label className="mb-1 block text-sm text-gray-600">适用销售渠道</label><Input placeholder="留空表示不限渠道" value={aliasForm.salesChannel} onChange={value => setAliasForm(prev => ({ ...prev, salesChannel: value as string }))} /></div><div><label className="mb-1 block text-sm text-gray-600">说明</label><Textarea value={aliasForm.remark} onChange={value => setAliasForm(prev => ({ ...prev, remark: value as string }))} /></div></div>
      </Dialog>

      <Dialog header={editingRecipient ? '编辑收货档案' : '添加收货档案'} visible={recipientVisible} width="600px" onClose={() => setRecipientVisible(false)} footer={<div className="flex justify-end gap-2"><Button onClick={() => setRecipientVisible(false)}>取消</Button><Button theme="primary" loading={saving} onClick={saveRecipient}>保存</Button></div>}>
        <div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-sm text-gray-600">标签</label><Input placeholder="例如：本人 / 公司 / 家人" value={recipientForm.label} onChange={value => setRecipientForm(prev => ({ ...prev, label: value as string }))} /></div><div><label className="mb-1 block text-sm text-gray-600">收货人 <span className="text-red-500">*</span></label><Input value={recipientForm.consignee} onChange={value => setRecipientForm(prev => ({ ...prev, consignee: value as string }))} /></div><div><label className="mb-1 block text-sm text-gray-600">电话 <span className="text-red-500">*</span></label><Input value={recipientForm.phone} onChange={value => setRecipientForm(prev => ({ ...prev, phone: value as string }))} /></div><div className="col-span-2"><label className="mb-1 block text-sm text-gray-600">地址 <span className="text-red-500">*</span></label><Input value={recipientForm.address} onChange={value => setRecipientForm(prev => ({ ...prev, address: value as string }))} /></div></div>
      </Dialog>
      </div>
    </div>
  );
}
