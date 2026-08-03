import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table } from 'tdesign-react';
import { Edit2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';
import { useSuppliers, type Supplier } from '../hooks/useSuppliers';

interface SupplierManageTabProps {
  canManage: boolean;
}

interface SupplierResult {
  success: boolean;
  errMsg?: string;
}

const EMPTY_FORM = {
  name: '',
  contactName: '',
  phone: '',
  address: '',
  remark: '',
  enabled: true,
  sort: 10,
};

export function SupplierManageTab({ canManage }: SupplierManageTabProps) {
  const { suppliers, loading, loadError, loadSuppliers } = useSuppliers();
  const [keyword, setKeyword] = useState('');
  const [dialogVisible, setDialogVisible] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSuppliers(false);
  }, [loadSuppliers]);

  const filteredSuppliers = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return suppliers;
    return suppliers.filter(item => (
      `${item.name} ${item.contactName} ${item.phone} ${item.address}`.toLowerCase().includes(normalized)
    ));
  }, [keyword, suppliers]);

  const openCreate = () => {
    setEditingSupplier(null);
    setForm({
      ...EMPTY_FORM,
      sort: suppliers.length > 0 ? Math.max(...suppliers.map(item => Number(item.sort || 0))) + 10 : 10,
    });
    setDialogVisible(true);
  };

  const openEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setForm({
      name: supplier.name || '',
      contactName: supplier.contactName || '',
      phone: supplier.phone || '',
      address: supplier.address || '',
      remark: supplier.remark || '',
      enabled: supplier.enabled !== false,
      sort: Number(supplier.sort || 0),
    });
    setDialogVisible(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      MessagePlugin.warning('请输入供应商名称');
      return;
    }

    setSaving(true);
    try {
      const result = await callFunction<SupplierResult>('manageSuppliers', {
        action: editingSupplier ? 'update' : 'create',
        supplierId: editingSupplier?._id,
        ...form,
        name: form.name.trim(),
        contactName: form.contactName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        remark: form.remark.trim(),
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '保存供应商失败');
        return;
      }
      MessagePlugin.success(editingSupplier ? '供应商已更新' : '供应商已新增');
      setDialogVisible(false);
      await loadSuppliers(false);
    } catch (error) {
      MessagePlugin.error('保存供应商失败: ' + String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (supplier: Supplier) => {
    if (!window.confirm(`确认删除供应商「${supplier.name}」吗？历史采购单中的供应商名称不会受影响。`)) return;

    try {
      const result = await callFunction<SupplierResult>('manageSuppliers', {
        action: 'delete',
        supplierId: supplier._id,
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '删除供应商失败');
        return;
      }
      MessagePlugin.success('供应商已删除');
      await loadSuppliers(false);
    } catch (error) {
      MessagePlugin.error('删除供应商失败: ' + String(error));
    }
  };

  const columns = useMemo(() => [
    { colKey: 'name', title: '供应商名称', minWidth: 180, ellipsis: true },
    { colKey: 'contactName', title: '联系人', width: 120, ellipsis: true },
    { colKey: 'phone', title: '联系电话', width: 150, ellipsis: true },
    { colKey: 'address', title: '联系地址', minWidth: 220, ellipsis: true },
    {
      colKey: 'enabled',
      title: '状态',
      width: 90,
      cell: ({ row }: { row: Supplier }) => (
        <span className={row.enabled !== false ? 'text-emerald-600' : 'text-gray-400'}>
          {row.enabled !== false ? '启用' : '禁用'}
        </span>
      ),
    },
    { colKey: 'sort', title: '排序', width: 80 },
    {
      colKey: 'op',
      title: '操作',
      width: 150,
      fixed: 'right' as const,
      cell: ({ row }: { row: Supplier }) => (
        <div className="flex gap-2">
          <Button size="small" variant="text" theme="primary" icon={<Edit2 size={14} />} disabled={!canManage} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button size="small" variant="text" theme="danger" icon={<Trash2 size={14} />} disabled={!canManage} onClick={() => handleDelete(row)}>
            删除
          </Button>
        </div>
      ),
    },
  ], [canManage]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">供应商配置</h3>
          <p className="mt-1 text-sm text-gray-500">维护采购业务可选择的供应商及联系方式</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input value={keyword} onChange={value => setKeyword(String(value))} placeholder="搜索名称 / 联系人 / 电话" className="w-64" clearable />
          <Button variant="outline" icon={<RefreshCw size={16} />} loading={loading} onClick={() => loadSuppliers(false)}>
            刷新
          </Button>
          <Button theme="primary" icon={<Plus size={16} />} disabled={!canManage} onClick={openCreate}>
            新增供应商
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="rounded border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <div className="overflow-hidden rounded border border-gray-100 bg-white">
        <Table
          data={filteredSuppliers}
          columns={columns}
          loading={loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
          empty="暂无供应商，请点击右上角新增"
        />
      </div>

      <Dialog
        header={editingSupplier ? '编辑供应商' : '新增供应商'}
        visible={dialogVisible}
        onClose={() => setDialogVisible(false)}
        onConfirm={handleSave}
        confirmBtn={{ content: '保存', loading: saving }}
        width="640px"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-gray-600">供应商名称 <span className="text-red-500">*</span></label>
              <Input value={form.name} onChange={value => setForm(prev => ({ ...prev, name: String(value) }))} placeholder="请输入供应商名称" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">联系人</label>
              <Input value={form.contactName} onChange={value => setForm(prev => ({ ...prev, contactName: String(value) }))} placeholder="请输入联系人" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">联系电话</label>
              <Input value={form.phone} onChange={value => setForm(prev => ({ ...prev, phone: String(value) }))} placeholder="请输入联系电话" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">状态</label>
              <Select
                value={form.enabled ? 'true' : 'false'}
                onChange={value => setForm(prev => ({ ...prev, enabled: value === 'true' }))}
                options={[{ label: '启用', value: 'true' }, { label: '禁用', value: 'false' }]}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm text-gray-600">联系地址</label>
              <Input value={form.address} onChange={value => setForm(prev => ({ ...prev, address: String(value) }))} placeholder="请输入联系地址" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">排序</label>
              <Input type="number" value={String(form.sort)} onChange={value => setForm(prev => ({ ...prev, sort: Number(value) || 0 }))} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">备注</label>
              <Input value={form.remark} onChange={value => setForm(prev => ({ ...prev, remark: String(value) }))} placeholder="选填" />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
