import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Table, Textarea } from 'tdesign-react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';

interface RoleRecord {
  _id: string;
  name: string;
  code?: string;
  description?: string;
  pagePermissions?: string[];
  actionPermissions?: string[];
  systemRole?: boolean;
}

interface ManageRolesResult {
  success: boolean;
  data?: RoleRecord[] | RoleRecord;
  errMsg?: string;
}

const PAGE_PERMISSION_OPTIONS = [
  { label: '首页', value: '/' },
  { label: '入库记录', value: '/inbound' },
  { label: '出库记录', value: '/outbound' },
  { label: '库存管理', value: '/inventory' },
  { label: '统计分析', value: '/stats' },
  { label: '操作日志', value: '/logs' },
  { label: '型号管理', value: '/models' },
  { label: '订单管理', value: '/orders' },
  { label: '开票管理', value: '/invoices' },
  { label: '公司信息', value: '/companies' },
  { label: '系统设置', value: '/settings' },
];

const ACTION_PERMISSION_OPTIONS = [
  { label: '全部权限', value: '*' },
  { label: '入库查询', value: 'inbound:read' },
  { label: '入库新增', value: 'inbound:create' },
  { label: '入库编辑', value: 'inbound:update' },
  { label: '入库删除', value: 'inbound:delete' },
  { label: '出库查询', value: 'outbound:read' },
  { label: '出库新增', value: 'outbound:create' },
  { label: '出库编辑', value: 'outbound:update' },
  { label: '出库删除', value: 'outbound:delete' },
  { label: '库存查询', value: 'inventory:read' },
  { label: '统计查看', value: 'stats:read' },
  { label: '日志查看', value: 'logs:read' },
  { label: '型号查询', value: 'models:read' },
  { label: '型号维护', value: 'models:write' },
  { label: '订单查询', value: 'orders:read' },
  { label: '订单新增', value: 'orders:create' },
  { label: '订单编辑', value: 'orders:update' },
  { label: '订单删除', value: 'orders:delete' },
  { label: '发票查询', value: 'invoices:read' },
  { label: '发票新增', value: 'invoices:create' },
  { label: '发票编辑', value: 'invoices:update' },
  { label: '发票删除', value: 'invoices:delete' },
  { label: '公司查询', value: 'companies:read' },
  { label: '公司维护', value: 'companies:write' },
  { label: '设置查看', value: 'settings:read' },
  { label: '设置修改', value: 'settings:update' },
  { label: '角色管理', value: 'settings:role_manage' },
  { label: '用户角色管理', value: 'settings:user_role_manage' },
];

const EMPTY_FORM = {
  name: '',
  code: '',
  description: '',
  pagePermissions: [] as string[],
  actionPermissions: [] as string[],
};

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

function PermissionCheckboxList({
  options,
  values,
  onChange,
}: {
  options: Array<{ label: string; value: string }>;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(option => (
        <label key={option.value} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={values.includes(option.value)}
            onChange={() => onChange(toggleValue(values, option.value))}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export function RoleManageTab({ onChanged }: { onChanged?: () => void }) {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRecord | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  const loadRoles = async () => {
    setLoading(true);
    try {
      const result = await callFunction<ManageRolesResult>('manageRoles', {
        data: { action: 'list' },
      });
      if (result.success) {
        setRoles(Array.isArray(result.data) ? result.data : []);
      } else {
        MessagePlugin.error(result.errMsg || '获取角色失败');
      }
    } catch (err) {
      MessagePlugin.error('获取角色失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRoles();
  }, []);

  const openCreate = () => {
    setEditingRole(null);
    setForm(EMPTY_FORM);
    setDialogVisible(true);
  };

  const openEdit = (role: RoleRecord) => {
    setEditingRole(role);
    setForm({
      name: role.name || '',
      code: role.code || '',
      description: role.description || '',
      pagePermissions: role.pagePermissions || [],
      actionPermissions: role.actionPermissions || [],
    });
    setDialogVisible(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      MessagePlugin.warning('请输入角色名称');
      return;
    }
    setSaving(true);
    try {
      const result = await callFunction<ManageRolesResult>('manageRoles', {
        data: {
          action: editingRole ? 'update' : 'create',
          roleId: editingRole?._id,
          name: form.name.trim(),
          code: form.code.trim(),
          description: form.description.trim(),
          pagePermissions: form.pagePermissions,
          actionPermissions: form.actionPermissions,
        },
      });
      if (result.success) {
        MessagePlugin.success(editingRole ? '角色已更新' : '角色已创建');
        setDialogVisible(false);
        loadRoles();
        onChanged?.();
      } else {
        MessagePlugin.error(result.errMsg || '保存角色失败');
      }
    } catch (err) {
      MessagePlugin.error('保存角色失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (role: RoleRecord) => {
    if (role.systemRole) {
      MessagePlugin.warning('系统内置角色不可删除');
      return;
    }
    setDeletingId(role._id);
    try {
      const result = await callFunction<ManageRolesResult>('manageRoles', {
        data: { action: 'delete', roleId: role._id },
      });
      if (result.success) {
        MessagePlugin.success('角色已删除');
        loadRoles();
        onChanged?.();
      } else {
        MessagePlugin.error(result.errMsg || '删除角色失败');
      }
    } catch (err) {
      MessagePlugin.error('删除角色失败: ' + String(err));
    } finally {
      setDeletingId('');
    }
  };

  const columns = useMemo(() => [
    { colKey: 'name', title: '角色名称', width: 160 },
    { colKey: 'description', title: '描述', ellipsis: true },
    {
      colKey: 'pagePermissions',
      title: '页面权限',
      width: 100,
      cell: ({ row }: { row: RoleRecord }) => row.pagePermissions?.length || 0,
    },
    {
      colKey: 'actionPermissions',
      title: '功能权限',
      width: 100,
      cell: ({ row }: { row: RoleRecord }) => row.actionPermissions?.includes('*') ? '全部' : (row.actionPermissions?.length || 0),
    },
    {
      colKey: 'op',
      title: '操作',
      width: 150,
      fixed: 'right' as const,
      cell: ({ row }: { row: RoleRecord }) => (
        <div className="flex gap-2">
          <Button size="small" variant="text" theme="primary" icon={<Edit2 size={14} />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            size="small"
            variant="text"
            theme="danger"
            icon={<Trash2 size={14} />}
            loading={deletingId === row._id}
            disabled={row.systemRole}
            onClick={() => handleDelete(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ], [deletingId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">角色管理</h3>
          <p className="text-sm text-gray-500 mt-1">配置角色可访问的页面和可执行的功能</p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={openCreate}>
          新建角色
        </Button>
      </div>

      <Table data={roles} columns={columns} loading={loading} rowKey="_id" stripe hover />

      <Dialog
        header={editingRole ? '编辑角色' : '新建角色'}
        visible={dialogVisible}
        onClose={() => setDialogVisible(false)}
        onConfirm={handleSave}
        confirmBtn={{ content: '保存', loading: saving }}
        width="760px"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">角色名称</label>
              <Input value={form.name} onChange={val => setForm(prev => ({ ...prev, name: val as string }))} />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">角色编码</label>
              <Input value={form.code} onChange={val => setForm(prev => ({ ...prev, code: val as string }))} />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">描述</label>
            <Textarea value={form.description} onChange={val => setForm(prev => ({ ...prev, description: val as string }))} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">页面权限</h4>
              <PermissionCheckboxList
                options={PAGE_PERMISSION_OPTIONS}
                values={form.pagePermissions}
                onChange={values => setForm(prev => ({ ...prev, pagePermissions: values }))}
              />
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">功能权限</h4>
              <PermissionCheckboxList
                options={ACTION_PERMISSION_OPTIONS}
                values={form.actionPermissions}
                onChange={values => setForm(prev => ({ ...prev, actionPermissions: values }))}
              />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
