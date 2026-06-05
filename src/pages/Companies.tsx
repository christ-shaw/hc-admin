import { useEffect, useState } from 'react';
import { Table, Button, Input, Dialog, MessagePlugin } from 'tdesign-react';
import { Plus, Pencil, Trash2, Building2 } from 'lucide-react';
import { CompanyTemplate } from '../types';
import { useCompanies } from '../hooks/useCompanies';

const EMPTY_COMPANY: Omit<CompanyTemplate, '_id' | 'createTime'> = {
  companyName: '',
  taxId: '',
  registeredAddress: '',
  contactPhone: '',
  bankName: '',
  bankAccount: '',
  bankCode: '',
};

export function Companies() {
  const companies = useCompanies();

  const [addVisible, setAddVisible] = useState(false);
  const [addForm, setAddForm] = useState<Omit<CompanyTemplate, '_id' | 'createTime'>>(EMPTY_COMPANY);
  const [editVisible, setEditVisible] = useState(false);
  const [editForm, setEditForm] = useState<Omit<CompanyTemplate, '_id' | 'createTime'>>(EMPTY_COMPANY);
  const [editId, setEditId] = useState('');
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CompanyTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    companies.fetchRecords();
  }, []);

  /** 新增 */
  const handleAddOpen = () => {
    setAddForm(EMPTY_COMPANY);
    setAddVisible(true);
  };

  const handleAddSave = async () => {
    if (!addForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    setSaving(true);
    try {
      const result = await companies.addCompany(addForm);
      if (result.success) {
        MessagePlugin.success('新增公司模版成功');
        setAddVisible(false);
      } else {
        MessagePlugin.error('新增失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 编辑 */
  const handleEditOpen = (record: CompanyTemplate) => {
    setEditId(record._id);
    setEditForm({
      companyName: record.companyName,
      taxId: record.taxId,
      registeredAddress: record.registeredAddress,
      contactPhone: record.contactPhone,
      bankName: record.bankName,
      bankAccount: record.bankAccount,
      bankCode: record.bankCode,
    });
    setEditVisible(true);
  };

  const handleEditSave = async () => {
    if (!editForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    setSaving(true);
    try {
      const success = await companies.updateCompany(editId, editForm);
      if (success) {
        MessagePlugin.success('修改成功');
        setEditVisible(false);
      } else {
        MessagePlugin.error('修改失败');
      }
    } catch (err) {
      MessagePlugin.error('修改异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 删除 */
  const handleDeleteConfirm = (record: CompanyTemplate) => {
    setDeleteTarget(record);
    setDeleteConfirmVisible(true);
  };

  const handleDeleteExec = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const success = await companies.deleteCompany(deleteTarget._id);
      if (success) {
        MessagePlugin.success('删除成功');
        setDeleteConfirmVisible(false);
        setDeleteTarget(null);
      } else {
        MessagePlugin.error('删除失败');
      }
    } catch (err) {
      MessagePlugin.error('删除异常: ' + String(err));
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    { colKey: 'companyName', title: '单位名称', width: 200, ellipsis: true },
    { colKey: 'taxId', title: '纳税人识别号', width: 200, ellipsis: true },
    { colKey: 'registeredAddress', title: '注册地址', width: 200, ellipsis: true },
    { colKey: 'contactPhone', title: '联系电话', width: 130 },
    { colKey: 'bankName', title: '开户行名称', width: 160, ellipsis: true },
    { colKey: 'bankCode', title: '开户行行号', width: 140 },
    { colKey: 'bankAccount', title: '账号', width: 180 },
    {
      colKey: 'op', title: '操作', width: 130, fixed: 'right' as const,
      cell: ({ row }: { row: CompanyTemplate }) => (
        <div className="flex gap-1">
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleEditOpen(row); }}>
            编辑
          </Button>
          <Button variant="text" theme="danger" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteConfirm(row); }}>
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">公司模版</h1>
          <p className="text-gray-500 mt-1">管理开票公司信息模版，新建发票时可快速选择</p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={handleAddOpen}>
          新增公司
        </Button>
      </div>

      {/* 表格 */}
      <div className="glass-card">
        <Table
          data={companies.records}
          columns={columns}
          loading={companies.loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
        />
      </div>

      {/* 新增弹窗 */}
      <Dialog
        header="新增公司模版"
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        width="600px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddVisible(false)}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleAddSave}>保存</Button>
          </div>
        }
      >
        <CompanyFormFields form={addForm} onChange={setAddForm} />
      </Dialog>

      {/* 编辑弹窗 */}
      <Dialog
        header="编辑公司模版"
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        width="600px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditVisible(false)}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleEditSave}>保存</Button>
          </div>
        }
      >
        <CompanyFormFields form={editForm} onChange={setEditForm} />
      </Dialog>

      {/* 删除确认 */}
      <Dialog
        header="确认删除"
        visible={deleteConfirmVisible}
        onClose={() => { setDeleteConfirmVisible(false); setDeleteTarget(null); }}
        width="420px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setDeleteConfirmVisible(false); setDeleteTarget(null); }}>取消</Button>
            <Button theme="danger" loading={deleting} onClick={handleDeleteExec}>确认删除</Button>
          </div>
        }
      >
        <p className="text-gray-600">
          确定要删除 <span className="font-medium text-gray-900">{deleteTarget?.companyName}</span> 吗？此操作不可撤销。
        </p>
      </Dialog>
    </div>
  );
}

/** 公司表单字段 */
function CompanyFormFields({ form, onChange }: {
  form: Omit<CompanyTemplate, '_id' | 'createTime'>;
  onChange: React.Dispatch<React.SetStateAction<Omit<CompanyTemplate, '_id' | 'createTime'>>>;
}) {
  return (
    <div className="space-y-4 max-h-[60vh] overflow-auto px-1">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">单位名称 <span className="text-red-500">*</span></label>
          <Input placeholder="请输入单位名称" value={form.companyName}
            onChange={val => onChange(prev => ({ ...prev, companyName: val as string }))} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">纳税人识别号</label>
          <Input placeholder="请输入纳税人识别号" value={form.taxId}
            onChange={val => onChange(prev => ({ ...prev, taxId: val as string }))} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">注册地址</label>
          <Input placeholder="请输入注册地址" value={form.registeredAddress}
            onChange={val => onChange(prev => ({ ...prev, registeredAddress: val as string }))} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">联系电话</label>
          <Input placeholder="请输入联系电话" value={form.contactPhone}
            onChange={val => onChange(prev => ({ ...prev, contactPhone: val as string }))} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">开户行名称</label>
          <Input placeholder="请输入开户行名称" value={form.bankName}
            onChange={val => onChange(prev => ({ ...prev, bankName: val as string }))} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">开户行行号</label>
          <Input placeholder="请输入开户行行号" value={form.bankCode}
            onChange={val => onChange(prev => ({ ...prev, bankCode: val as string }))} />
          </div>
          <div>
          <label className="block text-xs text-gray-500 mb-1">账号</label>
          <Input placeholder="请输入账号" value={form.bankAccount}
            onChange={val => onChange(prev => ({ ...prev, bankAccount: val as string }))} />
        </div>
      </div>
    </div>
  );
}
