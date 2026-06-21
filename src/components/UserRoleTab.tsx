import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table } from 'tdesign-react';
import { Edit2, Plus, RefreshCw, Trash2, UserCog } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';

interface RoleRecord {
  _id: string;
  name: string;
}

interface UserRoleRecord {
  _id?: string;
  userId: string;
  username?: string;
  nickName?: string;
  email?: string;
  phone?: string;
  roleId?: string;
  roleName?: string;
  roleCode?: string;
  assigned?: boolean;
}

interface ManageUserRolesResult {
  success: boolean;
  data?: UserRoleRecord[];
  errMsg?: string;
}

interface ManageRolesResult {
  success: boolean;
  data?: RoleRecord[];
  errMsg?: string;
}

const EMPTY_USER_FORM = {
  userId: '',
  username: '',
  nickName: '',
  email: '',
  phone: '',
};

export function UserRoleTab({ onChanged }: { onChanged?: () => void }) {
  const [users, setUsers] = useState<UserRoleRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // 用户编辑弹窗
  const [userDialogVisible, setUserDialogVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRoleRecord | null>(null);
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);
  const [savingUser, setSavingUser] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState('');

  // 角色分配弹窗
  const [assignDialogVisible, setAssignDialogVisible] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRoleRecord | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [assigning, setAssigning] = useState(false);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const result = await callFunction<ManageUserRolesResult>('manageUserRoles', {
        data: { action: 'list' },
      });
      if (result.success) {
        setUsers(result.data || []);
      } else {
        MessagePlugin.error(result.errMsg || '获取用户列表失败');
      }
    } catch (err) {
      MessagePlugin.error('获取用户列表失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const result = await callFunction<ManageRolesResult>('manageRoles', {
        data: { action: 'list' },
      });
      if (result.success) setRoles(result.data || []);
    } catch {
      // 角色下拉为空时再提示
    }
  };

  useEffect(() => {
    loadUsers();
    loadRoles();
  }, []);

  // ===== 用户镜像增删改 =====
  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm(EMPTY_USER_FORM);
    setUserDialogVisible(true);
  };

  const openEditUser = (user: UserRoleRecord) => {
    setEditingUser(user);
    setUserForm({
      userId: user.userId || '',
      username: user.username || '',
      nickName: user.nickName || '',
      email: user.email || '',
      phone: user.phone || '',
    });
    setUserDialogVisible(true);
  };

  const handleSaveUser = async () => {
    if (!userForm.userId.trim()) {
      MessagePlugin.warning('请填写 CloudBase 用户 ID');
      return;
    }
    if (!userForm.username.trim()) {
      MessagePlugin.warning('请填写用户名');
      return;
    }
    setSavingUser(true);
    try {
      console.log('[UserRoleTab] 调用 manageUserRoles, action:', editingUser ? 'updateUser' : 'createUser');
      const result = await callFunction<ManageUserRolesResult>('manageUserRoles', {
        data: {
          action: editingUser ? 'updateUser' : 'createUser',
          userId: userForm.userId.trim(),
          username: userForm.username.trim(),
          nickName: userForm.nickName.trim(),
          email: userForm.email.trim(),
          phone: userForm.phone.trim(),
        },
      });
      console.log('[UserRoleTab] manageUserRoles 返回:', result);
      if (result.success) {
        MessagePlugin.success(editingUser ? '用户已更新' : '用户已添加');
        setUserDialogVisible(false);
        loadUsers();
      } else {
        MessagePlugin.error(result.errMsg || '保存用户失败');
      }
    } catch (err) {
      MessagePlugin.error('保存用户失败: ' + String(err));
    } finally {
      setSavingUser(false);
    }
  };

  const handleDeleteUser = async (user: UserRoleRecord) => {
    setDeletingUserId(user.userId);
    try {
      const result = await callFunction<ManageUserRolesResult>('manageUserRoles', {
        data: { action: 'deleteUser', userId: user.userId },
      });
      if (result.success) {
        MessagePlugin.success('用户已删除');
        loadUsers();
        onChanged?.();
      } else {
        MessagePlugin.error(result.errMsg || '删除用户失败');
      }
    } catch (err) {
      MessagePlugin.error('删除用户失败: ' + String(err));
    } finally {
      setDeletingUserId('');
    }
  };

  // ===== 角色分配 =====
  const openAssign = (user: UserRoleRecord) => {
    setSelectedUser(user);
    setSelectedRoleId(user.roleId || '');
    setAssignDialogVisible(true);
  };

  const handleAssign = async () => {
    if (!selectedUser) return;
    if (!selectedRoleId) {
      MessagePlugin.warning('请选择角色');
      return;
    }
    setAssigning(true);
    try {
      const result = await callFunction<ManageUserRolesResult>('manageUserRoles', {
        data: {
          action: 'assign',
          userId: selectedUser.userId,
          username: selectedUser.username || '',
          nickName: selectedUser.nickName || '',
          roleId: selectedRoleId,
        },
      });
      if (result.success) {
        MessagePlugin.success('用户角色已更新');
        setAssignDialogVisible(false);
        loadUsers();
        onChanged?.();
      } else {
        MessagePlugin.error(result.errMsg || '分配角色失败');
      }
    } catch (err) {
      MessagePlugin.error('分配角色失败: ' + String(err));
    } finally {
      setAssigning(false);
    }
  };

  const roleOptions = roles.map(role => ({ label: role.name, value: role._id }));

  const columns = useMemo(() => [
    {
      colKey: 'username',
      title: '用户名',
      width: 160,
      cell: ({ row }: { row: UserRoleRecord }) => row.username || row.userId,
    },
    {
      colKey: 'nickName',
      title: '昵称',
      width: 140,
      cell: ({ row }: { row: UserRoleRecord }) => row.nickName || '-',
    },
    {
      colKey: 'roleName',
      title: '当前角色',
      width: 140,
      cell: ({ row }: { row: UserRoleRecord }) => row.roleName || <span className="text-gray-400">未分配</span>,
    },
    {
      colKey: 'phone',
      title: '手机号',
      width: 140,
      cell: ({ row }: { row: UserRoleRecord }) => row.phone || '-',
    },
    {
      colKey: 'userId',
      title: 'CloudBase 用户 ID',
      width: 200,
      ellipsis: true,
    },
    {
      colKey: 'op',
      title: '操作',
      width: 240,
      fixed: 'right' as const,
      cell: ({ row }: { row: UserRoleRecord }) => (
        <div className="flex gap-1">
          <Button size="small" variant="text" theme="primary" icon={<UserCog size={14} />} onClick={() => openAssign(row)}>
            分配角色
          </Button>
          <Button size="small" variant="text" theme="primary" icon={<Edit2 size={14} />} onClick={() => openEditUser(row)}>
            编辑
          </Button>
          <Button
            size="small"
            variant="text"
            theme="danger"
            icon={<Trash2 size={14} />}
            loading={deletingUserId === row.userId}
            onClick={() => handleDeleteUser(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ], [deletingUserId, roles]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">用户角色</h3>
          <p className="text-sm text-gray-500 mt-1">手工维护用户镜像，并为用户分配角色</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon={<RefreshCw size={16} />} onClick={loadUsers}>
            刷新
          </Button>
          <Button theme="primary" icon={<Plus size={16} />} onClick={openCreateUser}>
            添加用户
          </Button>
        </div>
      </div>

      <div className="text-xs text-gray-400 bg-blue-50 rounded-lg p-3">
        提示：CloudBase 用户 ID 可在 CloudBase 控制台「身份认证 → 用户管理」中查看，是用户的唯一标识。
      </div>

      <Table data={users} columns={columns} loading={loading} rowKey="userId" stripe hover />

      {/* 用户编辑弹窗 */}
      <Dialog
        header={editingUser ? '编辑用户' : '添加用户'}
        visible={userDialogVisible}
        onClose={() => setUserDialogVisible(false)}
        onConfirm={handleSaveUser}
        confirmBtn={{ content: '保存', loading: savingUser }}
        width="520px"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-600 mb-1">CloudBase 用户 ID <span className="text-red-500">*</span></label>
            <Input
              value={userForm.userId}
              onChange={val => setUserForm(prev => ({ ...prev, userId: val as string }))}
              placeholder="从 CloudBase 控制台复制用户 UID"
              disabled={!!editingUser}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">用户名 <span className="text-red-500">*</span></label>
            <Input
              value={userForm.username}
              onChange={val => setUserForm(prev => ({ ...prev, username: val as string }))}
              placeholder="登录用户名"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">昵称</label>
            <Input
              value={userForm.nickName}
              onChange={val => setUserForm(prev => ({ ...prev, nickName: val as string }))}
              placeholder="显示昵称"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">手机号</label>
              <Input
                value={userForm.phone}
                onChange={val => setUserForm(prev => ({ ...prev, phone: val as string }))}
                placeholder="手机号"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">邮箱</label>
              <Input
                value={userForm.email}
                onChange={val => setUserForm(prev => ({ ...prev, email: val as string }))}
                placeholder="邮箱"
              />
            </div>
          </div>
        </div>
      </Dialog>

      {/* 角色分配弹窗 */}
      <Dialog
        header="分配用户角色"
        visible={assignDialogVisible}
        onClose={() => setAssignDialogVisible(false)}
        onConfirm={handleAssign}
        confirmBtn={{ content: '保存', loading: assigning }}
        width="460px"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
            <div>用户：<span className="font-medium text-gray-900">{selectedUser?.username || selectedUser?.userId}</span></div>
            <div className="mt-1">昵称：{selectedUser?.nickName || '-'}</div>
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">角色</label>
            <Select
              value={selectedRoleId || undefined}
              onChange={val => setSelectedRoleId(val as string)}
              options={roleOptions}
              placeholder="请选择角色"
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
