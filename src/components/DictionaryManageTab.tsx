import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table } from 'tdesign-react';
import { Edit2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';
import { useDictionaries, type DictionaryGroup, type DictionaryItem } from '../contexts/DictionaryContext';

interface ManageDictionariesResult {
  success: boolean;
  initialized?: boolean;
  groups?: DictionaryGroup[];
  data?: Record<string, DictionaryItem[]>;
  errMsg?: string;
}

interface DictionaryManageTabProps {
  canManage: boolean;
}

const EMPTY_FORM = {
  value: '',
  label: '',
  sort: 0,
  enabled: true,
};

const CATEGORY_LABELS: Record<string, string> = {
  inbound: '出入库',
  order: '订单',
  invoice: '发票',
  common: '通用',
};

export function DictionaryManageTab({ canManage }: DictionaryManageTabProps) {
  const dictionaries = useDictionaries();
  const [groups, setGroups] = useState<DictionaryGroup[]>([]);
  const [itemsByGroup, setItemsByGroup] = useState<Record<string, DictionaryItem[]>>({});
  const [activeGroupCode, setActiveGroupCode] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<DictionaryItem | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const loadDictionaries = async () => {
    setLoading(true);
    try {
      const result = await callFunction<ManageDictionariesResult>('manageDictionaries', {
        data: { action: 'list' },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '获取数据字典失败');
        return;
      }

      const nextGroups = result.groups || [];
      setGroups(nextGroups);
      setItemsByGroup(result.data || {});
      setInitialized(!!result.initialized);
      setActiveGroupCode(prev => prev || nextGroups[0]?.code || '');
    } catch (err) {
      MessagePlugin.error('获取数据字典失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDictionaries();
  }, []);

  const activeGroup = groups.find(group => group.code === activeGroupCode);
  const activeItems = useMemo(() => {
    return [...(itemsByGroup[activeGroupCode] || [])]
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
  }, [activeGroupCode, itemsByGroup]);

  const openCreate = () => {
    if (!initialized) {
      MessagePlugin.warning('请先初始化默认字典');
      return;
    }
    setEditingItem(null);
    setForm({
      ...EMPTY_FORM,
      sort: activeItems.length > 0 ? Math.max(...activeItems.map(item => Number(item.sort || 0))) + 10 : 10,
    });
    setDialogVisible(true);
  };

  const openEdit = (item: DictionaryItem) => {
    if (!item._id) {
      MessagePlugin.warning('请先初始化默认字典');
      return;
    }
    setEditingItem(item);
    setForm({
      value: item.value || '',
      label: item.label || '',
      sort: Number(item.sort || 0),
      enabled: item.enabled !== false,
    });
    setDialogVisible(true);
  };

  const handleInitialize = async () => {
    setInitializing(true);
    try {
      const result = await callFunction<ManageDictionariesResult>('manageDictionaries', {
        data: { action: 'initializeDefault' },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '初始化默认字典失败');
        return;
      }
      MessagePlugin.success(result.errMsg || '默认字典已初始化');
      await loadDictionaries();
      await dictionaries.refreshDictionaries();
    } catch (err) {
      MessagePlugin.error('初始化默认字典失败: ' + String(err));
    } finally {
      setInitializing(false);
    }
  };

  const handleSave = async () => {
    if (!activeGroupCode) {
      MessagePlugin.warning('请选择字典组');
      return;
    }
    if (!form.value.trim()) {
      MessagePlugin.warning('请输入字典值');
      return;
    }
    if (!form.label.trim()) {
      MessagePlugin.warning('请输入显示名称');
      return;
    }

    setSaving(true);
    try {
      const result = await callFunction<ManageDictionariesResult>('manageDictionaries', {
        data: {
          action: editingItem ? 'updateItem' : 'createItem',
          itemId: editingItem?._id,
          groupCode: activeGroupCode,
          value: form.value.trim(),
          label: form.label.trim(),
          sort: Number(form.sort || 0),
          enabled: form.enabled,
        },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '保存字典项失败');
        return;
      }
      MessagePlugin.success(editingItem ? '字典项已更新' : '字典项已新增');
      setDialogVisible(false);
      await loadDictionaries();
      await dictionaries.refreshDictionaries();
    } catch (err) {
      MessagePlugin.error('保存字典项失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: DictionaryItem) => {
    if (!item._id) {
      MessagePlugin.warning('请先初始化默认字典');
      return;
    }
    if (!window.confirm(`确认删除或禁用「${item.label}」吗？系统内置项会被禁用，非内置项会被删除。`)) return;

    try {
      const result = await callFunction<ManageDictionariesResult>('manageDictionaries', {
        data: { action: 'deleteItem', itemId: item._id },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '删除字典项失败');
        return;
      }
      MessagePlugin.success(item.systemItem ? '系统内置项已禁用' : '字典项已删除');
      await loadDictionaries();
      await dictionaries.refreshDictionaries();
    } catch (err) {
      MessagePlugin.error('删除字典项失败: ' + String(err));
    }
  };

  const columns = useMemo(() => [
    { colKey: 'value', title: '字典值', width: 180, ellipsis: true },
    { colKey: 'label', title: '显示名称', ellipsis: true },
    { colKey: 'sort', title: '排序', width: 80 },
    {
      colKey: 'enabled',
      title: '状态',
      width: 90,
      cell: ({ row }: { row: DictionaryItem }) => row.enabled !== false ? '启用' : '禁用',
    },
    {
      colKey: 'systemItem',
      title: '类型',
      width: 90,
      cell: ({ row }: { row: DictionaryItem }) => row.systemItem ? '内置' : '自定义',
    },
    {
      colKey: 'op',
      title: '操作',
      width: 150,
      fixed: 'right' as const,
      cell: ({ row }: { row: DictionaryItem }) => (
        <div className="flex gap-2">
          <Button
            size="small"
            variant="text"
            theme="primary"
            icon={<Edit2 size={14} />}
            disabled={!canManage}
            onClick={() => openEdit(row)}
          >
            编辑
          </Button>
          <Button
            size="small"
            variant="text"
            theme="danger"
            icon={<Trash2 size={14} />}
            disabled={!canManage}
            onClick={() => handleDelete(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ], [canManage, initialized, activeItems]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">数据字典</h3>
          <p className="text-sm text-gray-500 mt-1">维护订单、发票、人员、账户、店铺、邮费等普通枚举项</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon={<RefreshCw size={16} />} loading={loading} onClick={loadDictionaries}>
            刷新
          </Button>
          <Button variant="outline" loading={initializing} disabled={!canManage} onClick={handleInitialize}>
            初始化默认字典
          </Button>
          <Button theme="primary" icon={<Plus size={16} />} disabled={!canManage || !activeGroupCode} onClick={openCreate}>
            新增字典项
          </Button>
        </div>
      </div>

      {!initialized && (
        <div className="rounded border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          当前展示的是本地默认字典。点击“初始化默认字典”后会写入数据库，之后可在此维护。
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        <div className="rounded border border-gray-100 bg-white p-2">
          {groups.map(group => (
            <button
              key={group.code}
              type="button"
              className={`mb-1 flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${
                activeGroupCode === group.code ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
              onClick={() => setActiveGroupCode(group.code)}
            >
              <span>{group.name}</span>
              <span className="text-xs text-gray-400">{CATEGORY_LABELS[group.category || ''] || group.category || '-'}</span>
            </button>
          ))}
        </div>

        <div className="rounded border border-gray-100 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-gray-800">{activeGroup?.name || '请选择字典组'}</div>
              <div className="text-xs text-gray-400">{activeGroup?.code || '-'}</div>
            </div>
            <div className="text-xs text-gray-400">共 {activeItems.length} 项</div>
          </div>
          <Table
            data={activeItems}
            columns={columns}
            loading={loading}
            rowKey="value"
            tableLayout="fixed"
            hover
            stripe
          />
        </div>
      </div>

      <Dialog
        header={editingItem ? '编辑字典项' : '新增字典项'}
        visible={dialogVisible}
        onClose={() => setDialogVisible(false)}
        onConfirm={handleSave}
        confirmBtn={{ content: '保存', loading: saving }}
        width="560px"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-gray-600">所属字典</label>
            <Input value={activeGroup?.name || activeGroupCode} readOnly />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm text-gray-600">字典值</label>
              <Input value={form.value} onChange={val => setForm(prev => ({ ...prev, value: val as string }))} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">显示名称</label>
              <Input value={form.label} onChange={val => setForm(prev => ({ ...prev, label: val as string }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm text-gray-600">排序</label>
              <Input type="number" value={String(form.sort)} onChange={val => setForm(prev => ({ ...prev, sort: Number(val) || 0 }))} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">状态</label>
              <Select
                value={form.enabled ? 'true' : 'false'}
                onChange={val => setForm(prev => ({ ...prev, enabled: val === 'true' }))}
                options={[
                  { label: '启用', value: 'true' },
                  { label: '禁用', value: 'false' },
                ]}
              />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
