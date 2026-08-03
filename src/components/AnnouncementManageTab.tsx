import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table, Tag, Textarea } from 'tdesign-react';
import { Archive, Edit2, Plus, Send } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';
import { formatDate } from '../utils/format';
import type { FeatureAnnouncement, ManageAnnouncementsResult } from '../types/announcement';

const ACTION_PATH_OPTIONS = [
  { label: '不设置功能入口', value: '' },
  { label: '订单管理', value: '/orders' },
  { label: '顺丰速运', value: '/sf-express' },
  { label: '采购管理', value: '/purchases' },
  { label: '入库记录', value: '/inbound' },
  { label: '出库记录', value: '/outbound' },
  { label: '库存管理', value: '/inventory' },
  { label: '开票管理', value: '/invoices' },
  { label: '公司信息', value: '/companies' },
  { label: '系统设置', value: '/settings' },
];

const EMPTY_FORM = {
  title: '',
  versionLabel: '',
  summary: '',
  content: '',
  actionPath: '',
};

const STATUS_META = {
  draft: { label: '草稿', theme: 'default' as const },
  published: { label: '已发布', theme: 'success' as const },
  archived: { label: '已下线', theme: 'warning' as const },
};

export function AnnouncementManageTab() {
  const [announcements, setAnnouncements] = useState<FeatureAnnouncement[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [editing, setEditing] = useState<FeatureAnnouncement | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState('');

  const loadAnnouncements = async () => {
    setLoading(true);
    try {
      const result = await callFunction<ManageAnnouncementsResult>('manageAnnouncements', {
        data: { action: 'listAdmin' },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '获取通知失败');
        return;
      }
      setAnnouncements(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      MessagePlugin.error('获取通知失败: ' + String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAnnouncements();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogVisible(true);
  };

  const openEdit = (announcement: FeatureAnnouncement) => {
    setEditing(announcement);
    setForm({
      title: announcement.title || '',
      versionLabel: announcement.versionLabel || '',
      summary: announcement.summary || '',
      content: announcement.content || '',
      actionPath: announcement.actionPath || '',
    });
    setDialogVisible(true);
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      MessagePlugin.warning('请输入通知标题');
      return;
    }
    if (!form.content.trim()) {
      MessagePlugin.warning('请输入功能说明');
      return;
    }

    setSaving(true);
    try {
      const result = await callFunction<ManageAnnouncementsResult>('manageAnnouncements', {
        data: {
          action: editing ? 'update' : 'create',
          announcementId: editing?._id,
          ...form,
        },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '保存失败');
        return;
      }
      MessagePlugin.success(editing ? '通知已保存' : '草稿已创建');
      setDialogVisible(false);
      await loadAnnouncements();
    } catch (error) {
      MessagePlugin.error('保存失败: ' + String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleStatusAction = async (announcement: FeatureAnnouncement, action: 'publish' | 'archive') => {
    const prompt = action === 'publish'
      ? `确认发布“${announcement.title}”？发布后用户进入首页会收到弹窗。`
      : `确认下线“${announcement.title}”？下线后用户将无法再查看。`;
    if (!window.confirm(prompt)) return;

    setActionId(announcement._id);
    try {
      const result = await callFunction<ManageAnnouncementsResult>('manageAnnouncements', {
        data: { action, announcementId: announcement._id },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '操作失败');
        return;
      }
      MessagePlugin.success(action === 'publish' ? '通知已发布' : '通知已下线');
      await loadAnnouncements();
    } catch (error) {
      MessagePlugin.error('操作失败: ' + String(error));
    } finally {
      setActionId('');
    }
  };

  const columns = useMemo(() => [
    {
      colKey: 'title',
      title: '通知',
      minWidth: 240,
      cell: ({ row }: { row: FeatureAnnouncement }) => (
        <div>
          <div className="font-medium text-gray-800">{row.title}</div>
          <div className="mt-1 line-clamp-1 text-xs text-gray-400">
            {[row.versionLabel, row.summary].filter(Boolean).join(' · ') || '暂无摘要'}
          </div>
        </div>
      ),
    },
    {
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }: { row: FeatureAnnouncement }) => {
        const meta = STATUS_META[row.status] || STATUS_META.draft;
        return <Tag theme={meta.theme} variant="light">{meta.label}</Tag>;
      },
    },
    {
      colKey: 'publishedAt',
      title: '发布时间',
      width: 160,
      cell: ({ row }: { row: FeatureAnnouncement }) => formatDate(row.publishedAt || null),
    },
    {
      colKey: 'updatedAt',
      title: '最后修改',
      width: 160,
      cell: ({ row }: { row: FeatureAnnouncement }) => formatDate(row.updatedAt || null),
    },
    {
      colKey: 'operation',
      title: '操作',
      width: 250,
      cell: ({ row }: { row: FeatureAnnouncement }) => (
        <div className="flex flex-wrap gap-2">
          {row.status !== 'archived' && (
            <Button size="small" variant="outline" icon={<Edit2 size={14} />} onClick={() => openEdit(row)}>
              编辑
            </Button>
          )}
          {row.status === 'draft' && (
            <Button
              size="small"
              theme="primary"
              icon={<Send size={14} />}
              loading={actionId === row._id}
              onClick={() => handleStatusAction(row, 'publish')}
            >
              发布
            </Button>
          )}
          {row.status !== 'archived' && (
            <Button
              size="small"
              theme="warning"
              variant="outline"
              icon={<Archive size={14} />}
              loading={actionId === row._id}
              onClick={() => handleStatusAction(row, 'archive')}
            >
              下线
            </Button>
          )}
        </div>
      ),
    },
  ], [actionId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">新功能通知</h3>
          <p className="mt-1 text-sm text-gray-500">
            先保存草稿，确认内容后再发布；已发布通知会在用户进入首页时弹出。
          </p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={openCreate}>新建通知</Button>
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
        编辑已发布通知不会让已读用户再次弹窗。如需再次提醒，请新建一条通知。
      </div>

      <Table
        data={announcements}
        columns={columns}
        loading={loading}
        rowKey="_id"
        tableLayout="fixed"
        stripe
        hover
        empty="暂无新功能通知"
      />

      <Dialog
        header={editing ? '编辑新功能通知' : '新建新功能通知'}
        visible={dialogVisible}
        onClose={() => setDialogVisible(false)}
        onConfirm={handleSave}
        confirmBtn={{ content: '保存草稿', loading: saving }}
        width="680px"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
            <div>
              <label className="mb-1 block text-sm text-gray-600">
                通知标题 <span className="text-red-500">*</span>
              </label>
              <Input
                value={form.title}
                maxlength={80}
                onChange={value => setForm(prev => ({ ...prev, title: String(value) }))}
                placeholder="例：顺丰模板导入功能上线"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">版本号</label>
              <Input
                value={form.versionLabel}
                maxlength={30}
                onChange={value => setForm(prev => ({ ...prev, versionLabel: String(value) }))}
                placeholder="例：v2.3.0"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">一句话摘要</label>
            <Input
              value={form.summary}
              maxlength={200}
              onChange={value => setForm(prev => ({ ...prev, summary: String(value) }))}
              placeholder="告诉用户这个功能能解决什么问题"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              功能说明 <span className="text-red-500">*</span>
            </label>
            <Textarea
              value={form.content}
              maxlength={5000}
              autosize={{ minRows: 8, maxRows: 16 }}
              onChange={value => setForm(prev => ({ ...prev, content: String(value) }))}
              placeholder={'建议说明：\n1. 新功能是什么\n2. 在哪里使用\n3. 使用时需要注意什么'}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">功能入口</label>
            <Select
              value={form.actionPath}
              options={ACTION_PATH_OPTIONS}
              onChange={value => setForm(prev => ({ ...prev, actionPath: String(value) }))}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
