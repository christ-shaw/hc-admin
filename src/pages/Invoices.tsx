import { useEffect, useState, useRef } from 'react';
import { Table, Button, Input, Select, Tag, Dialog, MessagePlugin } from 'tdesign-react';
import { Search, RotateCcw, Plus, Eye, Download, Upload, X, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { InvoiceRecord, InvoiceFilters, INVOICE_STATUS_MAP, CompanyTemplate, InvoiceFile } from '../types';
import { useInvoices } from '../hooks/useInvoices';
import { callFunction, getCurrentOperatorName, uploadToCloudStorage, getCloudFileURLs } from '../lib/cloudbase';
import { formatDate } from '../utils/format';
import { SHOP_NAMES } from '../data/productDict';

const STATUS_TAG_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  '已开票': 'success',
  '未开票': 'warning',
};

const EMPTY_INVOICE: Omit<InvoiceRecord, '_id' | 'createTime'> = {
  applyDate: '',
  companyName: '',
  applicant: '',
  shopName: '',
  status: '未开票',
  taxId: '',
  registeredAddress: '',
  contactPhone: '',
  bankName: '',
  bankAccount: '',
  bankCode: '',
  invoiceCategory: '',
  invoiceAmount: 0,
};

export function Invoices() {
  const invoices = useInvoices();

  const [filters, setFilters] = useState<InvoiceFilters>({});
  const [detailVisible, setDetailVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<InvoiceRecord | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [addForm, setAddForm] = useState<Omit<InvoiceRecord, '_id' | 'createTime'>>(EMPTY_INVOICE);
  const [addStep, setAddStep] = useState(1); // 1=选择店铺, 2=公司信息, 3=开票类目和金额
  const [editVisible, setEditVisible] = useState(false);
  const [editForm, setEditForm] = useState<Omit<InvoiceRecord, '_id' | 'createTime'>>(EMPTY_INVOICE);
  const [editId, setEditId] = useState('');
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InvoiceRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [companySuggestions, setCompanySuggestions] = useState<CompanyTemplate[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [companySelected, setCompanySelected] = useState(false);
  const [companyConfirmVisible, setCompanyConfirmVisible] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // 开票上传相关状态
  const [invoiceUploadVisible, setInvoiceUploadVisible] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<InvoiceRecord | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // 预览相关状态
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewRecord, setPreviewRecord] = useState<InvoiceRecord | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Array<{ fileID: string; tempFileURL: string; fileName: string }>>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    invoices.fetchRecords();
  }, []);

  // 点击外部关闭建议列表
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /** 搜索公司 */
  const searchCompanies = async (keyword: string) => {
    if (!keyword.trim()) {
      setCompanySuggestions([]);
      setShowSuggestions(false);
      return;
    }
    try {
      const result = await callFunction<{ success?: boolean; data: CompanyTemplate[] }>('queryCompanies', {
        data: { companyName: keyword.trim(), limit: 10 },
      });
      const list = result.data || [];
      setCompanySuggestions(list);
      setShowSuggestions(list.length > 0);
    } catch {
      setCompanySuggestions([]);
    }
  };

  /** 公司名称输入变化 */
  const handleCompanyNameChange = (val: string) => {
    setAddForm(prev => ({
      ...prev,
      companyName: val as string,
      taxId: '',
      registeredAddress: '',
      contactPhone: '',
      bankName: '',
      bankAccount: '',
      bankCode: '',
    }));
    setCompanySelected(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => searchCompanies(val as string), 300);
  };

  /** 选中公司建议 */
  const handleSelectCompany = (company: CompanyTemplate) => {
    setAddForm(prev => ({
      ...prev,
      companyName: company.companyName,
      taxId: company.taxId || '',
      registeredAddress: company.registeredAddress || '',
      contactPhone: company.contactPhone || '',
      bankName: company.bankName || '',
      bankAccount: company.bankAccount || '',
      bankCode: company.bankCode || '',
    }));
    setCompanySelected(true);
    setShowSuggestions(false);
    setCompanySuggestions([]);
  };

  const handleSearch = () => {
    invoices.resetFilters();
    const searchFilters: InvoiceFilters = { ...filters };
    if (searchFilters.companyName) searchFilters.companyName = searchFilters.companyName.trim();
    if (searchFilters.applicant) searchFilters.applicant = searchFilters.applicant.trim();
    invoices.fetchRecords(null, searchFilters);
  };

  const handleReset = () => {
    setFilters({});
    invoices.resetFilters();
    invoices.fetchRecords(null, {});
  };

  const handleDetail = (record: InvoiceRecord) => {
    setCurrentRecord(record);
    setDetailVisible(true);
  };

  /** 新增 */
  const handleAddOpen = async () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const applicant = await getCurrentOperatorName();
    setAddForm({ ...EMPTY_INVOICE, applyDate: dateStr, applicant });
    setAddStep(1);
    setAddVisible(true);
  };

  /** 新增 - 下一步 */
  const handleAddNext = () => {
    if (addStep === 1 && !addForm.shopName) {
      MessagePlugin.warning('请选择店铺');
      return;
    }
    if (addStep === 2 && !addForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    setAddStep(prev => Math.min(prev + 1, 3));
  };

  /** 新增 - 上一步 */
  const handleAddPrev = () => {
    setAddStep(prev => Math.max(prev - 1, 1));
  };

  const handleAddSave = async () => {
    if (!addForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    setSaving(true);
    try {
      if (!companySelected) {
        const queryResult = await callFunction<{ success?: boolean; data: CompanyTemplate[] }>('queryCompanies', {
          data: { companyName: addForm.companyName.trim(), limit: 1 },
        });
        const existing = queryResult.data || [];
        if (existing.length === 0) {
          setSaving(false);
          setCompanyConfirmVisible(true);
          return;
        }
      }
      await doSaveInvoice();
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
      setSaving(false);
    }
  };

  /** 确认保存公司信息并提交发票 */
  const handleCompanyConfirm = async () => {
    setCompanyConfirmVisible(false);
    setSaving(true);
    try {
      await callFunction('saveCompany', {
        data: {
          company: {
            companyName: addForm.companyName.trim(),
            taxId: addForm.taxId || '',
            registeredAddress: addForm.registeredAddress || '',
            contactPhone: addForm.contactPhone || '',
            bankName: addForm.bankName || '',
            bankAccount: addForm.bankAccount || '',
            bankCode: addForm.bankCode || '',
          },
        },
      });
      await doSaveInvoice();
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
      setSaving(false);
    }
  };

  /** 实际保存发票 */
  const doSaveInvoice = async () => {
    const result = await invoices.addInvoice(addForm);
    if (result.success) {
      MessagePlugin.success('新增发票申请成功');
      setAddVisible(false);
      setAddForm(EMPTY_INVOICE);
      setAddStep(1);
      setCompanySelected(false);
    } else {
      MessagePlugin.error('新增失败: ' + (result.errMsg || '未知错误'));
    }
    setSaving(false);
  };

  /** 编辑 */
  const handleEditOpen = (record: InvoiceRecord) => {
    setEditId(record._id);
    setEditForm({
      applyDate: record.applyDate,
      companyName: record.companyName,
      applicant: record.applicant,
      shopName: record.shopName,
      status: record.status,
      taxId: record.taxId,
      registeredAddress: record.registeredAddress,
      contactPhone: record.contactPhone,
      bankName: record.bankName,
      bankAccount: record.bankAccount,
      bankCode: record.bankCode,
      invoiceCategory: record.invoiceCategory,
      invoiceAmount: record.invoiceAmount,
      invoiceFiles: record.invoiceFiles,
      completedTime: record.completedTime,
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
      const success = await invoices.updateInvoice(editId, editForm);
      if (success) {
        MessagePlugin.success('修改发票成功');
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
  const handleDeleteConfirm = (record: InvoiceRecord) => {
    setDeleteTarget(record);
    setDeleteConfirmVisible(true);
  };

  const handleDeleteExec = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const success = await invoices.deleteInvoice(deleteTarget._id);
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

  /** 开票 - 打开上传弹窗 */
  const handleOpenInvoice = (record: InvoiceRecord) => {
    setUploadTarget(record);
    setUploadFiles([]);
    setInvoiceUploadVisible(true);
  };

  /** 选择上传文件 */
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setUploadFiles(prev => [...prev, ...Array.from(files)]);
    // 重置 input 以便再次选择同一文件
    if (uploadInputRef.current) uploadInputRef.current.value = '';
  };

  /** 移除已选文件 */
  const handleRemoveFile = (index: number) => {
    setUploadFiles(prev => prev.filter((_, i) => i !== index));
  };

  /** 确认开票 - 上传文件并更新状态 */
  const handleConfirmInvoice = async () => {
    if (!uploadTarget || uploadFiles.length === 0) {
      MessagePlugin.warning('请选择要上传的电子发票图片');
      return;
    }
    setUploading(true);
    try {
      const invoiceFiles: InvoiceFile[] = [];
      // 串行上传每张图片
      for (const file of uploadFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'png';
        const cloudPath = `invoices/${uploadTarget._id}_${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        invoiceFiles.push({ fileID, fileName: file.name });
      }

      // 更新发票记录：状态改为已开票，保存文件列表和完成时间
      const now = new Date();
      const completedTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const success = await invoices.updateInvoice(uploadTarget._id, {
        status: '已开票',
        invoiceFiles,
        completedTime,
      });
      if (success) {
        MessagePlugin.success('开票成功');
        setInvoiceUploadVisible(false);
        setUploadTarget(null);
        setUploadFiles([]);
      } else {
        MessagePlugin.error('开票失败');
      }
    } catch (err) {
      MessagePlugin.error('开票异常: ' + String(err));
    } finally {
      setUploading(false);
    }
  };

  /** 预览电子发票 */
  const handlePreview = async (record: InvoiceRecord) => {
    setPreviewRecord(record);
    setPreviewVisible(true);
    setPreviewLoading(true);
    setPreviewUrls([]);
    try {
      if (record.invoiceFiles && record.invoiceFiles.length > 0) {
        const fileIDs = record.invoiceFiles.map(f => f.fileID);
        const urls = await getCloudFileURLs(fileIDs);
        setPreviewUrls(urls.map((u, i) => ({
          ...u,
          fileName: record.invoiceFiles![i]?.fileName || `图片${i + 1}`,
        })));
      }
    } catch (err) {
      MessagePlugin.error('获取图片链接失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 下载单张图片 */
  const handleDownloadImage = (url: string, fileName: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const columns = [
    { colKey: 'applyDate', title: '申请日期', width: 110, cell: ({ row }: { row: InvoiceRecord }) => formatDate(row.applyDate, false) },
    { colKey: 'companyName', title: '公司名称', width: 180, ellipsis: true },
    { colKey: 'shopName', title: '店铺名字', width: 100 },
    { colKey: 'applicant', title: '开票申请人', width: 90 },
    {
      colKey: 'status', title: '开票状态', width: 90,
      cell: ({ row }: { row: InvoiceRecord }) => {
        const theme = STATUS_TAG_THEME[row.status] || 'default';
        return <Tag theme={theme} variant="light">{row.status}</Tag>;
      },
    },
    {
      colKey: 'op', title: '操作', width: 280, fixed: 'right' as const,
      cell: ({ row }: { row: InvoiceRecord }) => (
        <div className="flex gap-1 flex-wrap">
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetail(row); }}>
            详情
          </Button>
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleEditOpen(row); }}>
            编辑
          </Button>
          <Button variant="text" theme="danger" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteConfirm(row); }}>
            删除
          </Button>
          {row.status === '已开票' ? (
            <>
              <Button variant="text" theme="primary" size="small"
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); handlePreview(row); }}>
                <Eye size={14} className="mr-0.5" />预览
              </Button>
              <Button variant="text" theme="primary" size="small"
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); handlePreview(row); }}>
                <Download size={14} className="mr-0.5" />下载
              </Button>
            </>
          ) : (
            <Button variant="text" theme="success" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleOpenInvoice(row); }}>
              <Upload size={14} className="mr-0.5" />开票
            </Button>
          )}
        </div>
      ),
    },
  ];

  const displayRecords = invoices.getPageRecords(invoices.currentPage);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">发票管理</h1>
          <p className="text-gray-500 mt-1">管理开票申请</p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={handleAddOpen}>
          新增发票申请
        </Button>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">公司名称</label>
            <Input placeholder="请输入公司名称" value={filters.companyName || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, companyName: val as string }))} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">开票申请人</label>
            <Input placeholder="请输入申请人" value={filters.applicant || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, applicant: val as string }))} />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500 mb-1">开票状态</label>
            <Select placeholder="全部" value={filters.status || undefined}
              onChange={(val) => setFilters(prev => ({ ...prev, status: val as string }))}
              options={[{ label: '全部', value: '' }, ...Object.keys(INVOICE_STATUS_MAP).map(v => ({ label: v, value: v }))]}
              popupProps={{ attach: 'body' }} />
          </div>
          <div className="flex items-end gap-2">
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      {/* 表格 */}
      <div className="glass-card">
        <Table
          data={displayRecords}
          columns={columns}
          loading={invoices.loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
        />
        {/* 分页 */}
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <Button size="small" variant="outline" disabled={invoices.currentPage <= 1}
            onClick={() => invoices.setCurrentPage(invoices.currentPage - 1)}>
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {invoices.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!invoices.hasMore}
            onClick={() => invoices.fetchRecords(invoices.cursor)}>
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {invoices.totalRecords} 条</span>
        </div>
      </div>

      {/* 详情弹窗 */}
      <Dialog header="发票详情" visible={detailVisible} onClose={() => setDetailVisible(false)} width="600px"
        footer={<Button onClick={() => setDetailVisible(false)}>关闭</Button>}>
        {currentRecord && (
          <div className="space-y-2 text-sm">
            <DetailRow label="申请日期" value={formatDate(currentRecord.applyDate, false)} />
            <DetailRow label="单位名称" value={currentRecord.companyName} />
            <DetailRow label="店铺名字" value={currentRecord.shopName} />
            <DetailRow label="开票申请人" value={currentRecord.applicant} />
            <DetailRow label="开票状态" value={
              <Tag theme={STATUS_TAG_THEME[currentRecord.status] || 'default'} variant="light">
                {currentRecord.status}
              </Tag>
            } />
            <DetailRow label="纳税人识别号" value={currentRecord.taxId} />
            <DetailRow label="注册地址" value={currentRecord.registeredAddress} />
            <DetailRow label="联系电话" value={currentRecord.contactPhone} />
            <DetailRow label="开户行名称" value={currentRecord.bankName} />
            <DetailRow label="账号" value={currentRecord.bankAccount} />
            <DetailRow label="开户行行号" value={currentRecord.bankCode} />
            <DetailRow label="开票类目" value={currentRecord.invoiceCategory} />
            <DetailRow label="开票金额" value={currentRecord.invoiceAmount ? `¥${currentRecord.invoiceAmount}` : '-'} />
            {currentRecord.status === '已开票' && (
              <>
                <div className="border-t border-gray-100 pt-3 mt-3">
                  <h4 className="font-medium text-gray-700 mb-2">开票完成信息</h4>
                </div>
                {currentRecord.invoiceFiles && currentRecord.invoiceFiles.length > 0 && (
                  <DetailRow label="电子发票" value={
                    <InvoiceImagePreview files={currentRecord.invoiceFiles} />
                  } />
                )}
                <DetailRow label="开票完成时间" value={currentRecord.completedTime ? formatDate(currentRecord.completedTime) : '-'} />
              </>
            )}
          </div>
        )}
      </Dialog>

      {/* 新增发票弹窗 - 分步向导 */}
      <Dialog
        header="新增发票申请"
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        width="680px"
        footer={
          <div className="flex justify-between">
            <div>
              {addStep > 1 && (
                <Button variant="outline" icon={<ChevronLeft size={16} />} onClick={handleAddPrev}>上一步</Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setAddVisible(false)}>取消</Button>
              {addStep < 3 ? (
                <Button theme="primary" icon={<ChevronRight size={16} />} onClick={handleAddNext}>下一步</Button>
              ) : (
                <Button theme="primary" loading={saving} icon={<Check size={16} />} onClick={handleAddSave}>提交申请</Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {/* 步骤指示器 */}
          <div className="flex items-center justify-center gap-0 mb-2">
            {[
              { step: 1, label: '选择店铺' },
              { step: 2, label: '公司信息' },
              { step: 3, label: '开票类目' },
            ].map((item, idx) => (
              <div key={item.step} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    addStep > item.step
                      ? 'bg-blue-500 text-white'
                      : addStep === item.step
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-500'
                  }`}>
                    {addStep > item.step ? <Check size={16} /> : item.step}
                  </div>
                  <span className={`text-xs mt-1 ${addStep >= item.step ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                    {item.label}
                  </span>
                </div>
                {idx < 2 && (
                  <div className={`w-16 h-0.5 mx-2 mb-4 ${addStep > item.step ? 'bg-blue-500' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>

          {/* 步骤1: 选择店铺 */}
          {addStep === 1 && (
            <div className="py-4">
              <h4 className="text-sm font-medium text-gray-600 mb-4">请选择开票店铺</h4>
              <div className="w-full">
                <label className="block text-xs text-gray-500 mb-1">店铺名字 <span className="text-red-500">*</span></label>
                <Select placeholder="请选择店铺" value={addForm.shopName || undefined}
                  onChange={val => setAddForm(prev => ({ ...prev, shopName: val as string }))}
                  options={SHOP_NAMES.map(v => ({ label: v, value: v }))}
                  popupProps={{ attach: 'body' }}
                  size="large" />
              </div>
            </div>
          )}

          {/* 步骤2: 公司信息 */}
          {addStep === 2 && (
            <div className="max-h-[55vh] overflow-auto px-1">
              <div className="mb-4">
                <h4 className="text-sm font-medium text-gray-600 mb-2">公司信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 relative">
                    <label className="block text-xs text-gray-500 mb-1">单位名称 <span className="text-red-500">*</span></label>
                    <Input placeholder="输入单位名称搜索" value={addForm.companyName}
                      onChange={val => handleCompanyNameChange(val as string)} />
                    {showSuggestions && companySuggestions && companySuggestions.length > 0 && (
                      <div ref={suggestionsRef} className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                        {companySuggestions.map(company => (
                          <button key={company._id} type="button"
                            className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0 cursor-pointer"
                            onClick={() => handleSelectCompany(company)}>
                            <div className="font-medium text-gray-800">{company.companyName}</div>
                            <div className="text-xs text-gray-400">{company.taxId}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">纳税人识别号</label>
                    <Input placeholder="纳税人识别号" value={addForm.taxId}
                      onChange={val => setAddForm(prev => ({ ...prev, taxId: val as string }))} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">注册地址</label>
                    <Input placeholder="注册地址" value={addForm.registeredAddress}
                      onChange={val => setAddForm(prev => ({ ...prev, registeredAddress: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">联系电话</label>
                    <Input placeholder="联系电话" value={addForm.contactPhone}
                      onChange={val => setAddForm(prev => ({ ...prev, contactPhone: val as string }))} />
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-gray-600 mb-2">开户行信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">开户行名称</label>
                    <Input placeholder="开户行名称" value={addForm.bankName}
                      onChange={val => setAddForm(prev => ({ ...prev, bankName: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">开户行行号</label>
                    <Input placeholder="开户行行号" value={addForm.bankCode}
                      onChange={val => setAddForm(prev => ({ ...prev, bankCode: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">账号</label>
                    <Input placeholder="账号" value={addForm.bankAccount}
                      onChange={val => setAddForm(prev => ({ ...prev, bankAccount: val as string }))} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 步骤3: 开票类目和金额 */}
          {addStep === 3 && (
            <div className="py-4">
              <h4 className="text-sm font-medium text-gray-600 mb-4">开票类目和金额</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">开票类目</label>
                  <Input placeholder="开票类目" value={addForm.invoiceCategory}
                    onChange={val => setAddForm(prev => ({ ...prev, invoiceCategory: val as string }))} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">开票金额</label>
                  <Input type="number" placeholder="开票金额" value={addForm.invoiceAmount ? String(addForm.invoiceAmount) : ''}
                    onChange={val => setAddForm(prev => ({ ...prev, invoiceAmount: Number(val) }))} />
                </div>
              </div>
              {/* 已填信息确认 */}
              <div className="mt-6 p-3 bg-gray-50 rounded-lg">
                <h5 className="text-xs font-medium text-gray-500 mb-2">已填信息确认</h5>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-gray-400">店铺：</span><span className="text-gray-700">{addForm.shopName || '-'}</span></div>
                  <div><span className="text-gray-400">单位：</span><span className="text-gray-700">{addForm.companyName || '-'}</span></div>
                  <div><span className="text-gray-400">申请人：</span><span className="text-gray-700">{addForm.applicant || '-'}</span></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      {/* 编辑发票弹窗 */}
      <Dialog
        header="编辑发票"
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        width="680px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditVisible(false)}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleEditSave}>保存</Button>
          </div>
        }
      >
        <InvoiceFormFields form={editForm} onChange={setEditForm} isEdit />
      </Dialog>

      {/* 删除确认弹窗 */}
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
          确定要删除 <span className="font-medium text-gray-900">{deleteTarget?.companyName}</span> 的发票申请吗？此操作不可撤销。
        </p>
      </Dialog>

      {/* 公司不存在确认弹窗 */}
      <Dialog
        header="提示"
        visible={companyConfirmVisible}
        onClose={() => setCompanyConfirmVisible(false)}
        width="420px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCompanyConfirmVisible(false)}>取消</Button>
            <Button theme="primary" onClick={handleCompanyConfirm}>继续</Button>
          </div>
        }
      >
        <p className="text-gray-600">
          公司「<span className="font-medium text-gray-900">{addForm.companyName}</span>」不在系统数据库中，系统将自动保存该公司信息，是否继续？
        </p>
      </Dialog>

      {/* 开票上传弹窗 */}
      <Dialog
        header="上传电子发票"
        visible={invoiceUploadVisible}
        onClose={() => { setInvoiceUploadVisible(false); setUploadTarget(null); setUploadFiles([]); }}
        width="560px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setInvoiceUploadVisible(false); setUploadTarget(null); setUploadFiles([]); }}>取消</Button>
            <Button theme="primary" loading={uploading} onClick={handleConfirmInvoice}>确认开票</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            为 <span className="font-medium text-gray-800">{uploadTarget?.companyName}</span> 上传电子发票二维码图片（支持多张）
          </p>
          <div>
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button variant="outline" icon={<Upload size={16} />} onClick={() => uploadInputRef.current?.click()}>
              选择图片
            </Button>
          </div>
          {uploadFiles.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              {uploadFiles.map((file, index) => (
                <div key={index} className="relative group border border-gray-200 rounded-lg overflow-hidden">
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    className="w-full h-28 object-contain bg-gray-50"
                  />
                  <button
                    type="button"
                    className="absolute top-1 right-1 w-6 h-6 bg-black/50 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    onClick={() => handleRemoveFile(index)}
                  >
                    <X size={14} />
                  </button>
                  <div className="px-2 py-1 text-xs text-gray-500 truncate">{file.name}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      {/* 预览/下载弹窗 */}
      <Dialog
        header="电子发票预览"
        visible={previewVisible}
        onClose={() => { setPreviewVisible(false); setPreviewRecord(null); setPreviewUrls([]); }}
        width="680px"
        footer={<Button onClick={() => { setPreviewVisible(false); setPreviewRecord(null); setPreviewUrls([]); }}>关闭</Button>}
      >
        {previewLoading ? (
          <div className="flex justify-center py-8 text-gray-400">加载中...</div>
        ) : previewUrls.length === 0 ? (
          <div className="flex justify-center py-8 text-gray-400">暂无电子发票图片</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 max-h-[60vh] overflow-auto">
            {previewUrls.map((item, index) => (
              <div key={index} className="border border-gray-200 rounded-lg overflow-hidden">
                <img
                  src={item.tempFileURL}
                  alt={item.fileName}
                  className="w-full h-48 object-contain bg-gray-50"
                />
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
                  <span className="text-xs text-gray-500 truncate flex-1">{item.fileName}</span>
                  <Button
                    variant="text"
                    theme="primary"
                    size="small"
                    icon={<Download size={14} />}
                    onClick={() => handleDownloadImage(item.tempFileURL, item.fileName)}
                  >
                    下载
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** 发票表单字段（新增/编辑共用） */
function InvoiceFormFields({ form, onChange, isEdit = false, onCompanyNameChange, companySuggestions, showSuggestions, onSelectCompany, suggestionsRef }: {
  form: Omit<InvoiceRecord, '_id' | 'createTime'>;
  onChange: React.Dispatch<React.SetStateAction<Omit<InvoiceRecord, '_id' | 'createTime'>>>;
  isEdit?: boolean;
  onCompanyNameChange?: (val: string) => void;
  companySuggestions?: CompanyTemplate[];
  showSuggestions?: boolean;
  onSelectCompany?: (company: CompanyTemplate) => void;
  suggestionsRef?: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="space-y-4 max-h-[70vh] overflow-auto px-1">
      {/* 公司信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">公司信息</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 relative">
            <label className="block text-xs text-gray-500 mb-1">单位名称 <span className="text-red-500">*</span></label>
            <Input placeholder="输入单位名称搜索" value={form.companyName}
              onChange={val => {
                if (onCompanyNameChange) {
                  onCompanyNameChange(val as string);
                } else {
                  onChange(prev => ({ ...prev, companyName: val as string }));
                }
              }} />
            {showSuggestions && companySuggestions && companySuggestions.length > 0 && (
              <div ref={suggestionsRef} className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                {companySuggestions.map(company => (
                  <button key={company._id} type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0 cursor-pointer"
                    onClick={() => onSelectCompany?.(company)}>
                    <div className="font-medium text-gray-800">{company.companyName}</div>
                    <div className="text-xs text-gray-400">{company.taxId}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">纳税人识别号</label>
            <Input placeholder="纳税人识别号" value={form.taxId}
              onChange={val => onChange(prev => ({ ...prev, taxId: val as string }))} />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">注册地址</label>
            <Input placeholder="注册地址" value={form.registeredAddress}
              onChange={val => onChange(prev => ({ ...prev, registeredAddress: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">联系电话</label>
            <Input placeholder="联系电话" value={form.contactPhone}
              onChange={val => onChange(prev => ({ ...prev, contactPhone: val as string }))} />
          </div>
        </div>
      </div>

      {/* 开户行信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">开户行信息</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">开户行名称</label>
            <Input placeholder="开户行名称" value={form.bankName}
              onChange={val => onChange(prev => ({ ...prev, bankName: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">开户行行号</label>
            <Input placeholder="开户行行号" value={form.bankCode}
              onChange={val => onChange(prev => ({ ...prev, bankCode: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">账号</label>
            <Input placeholder="账号" value={form.bankAccount}
              onChange={val => onChange(prev => ({ ...prev, bankAccount: val as string }))} />
          </div>
        </div>
      </div>

      {/* 开票类目、店铺和金额 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">开票类目和金额</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">开票类目</label>
            <Input placeholder="开票类目" value={form.invoiceCategory}
              onChange={val => onChange(prev => ({ ...prev, invoiceCategory: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">店铺名字 <span className="text-red-500">*</span></label>
            <Select placeholder="请选择店铺" value={form.shopName || undefined}
              onChange={val => onChange(prev => ({ ...prev, shopName: val as string }))}
              options={SHOP_NAMES.map(v => ({ label: v, value: v }))}
              popupProps={{ attach: 'body' }} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">开票金额</label>
            <Input type="number" placeholder="开票金额" value={form.invoiceAmount ? String(form.invoiceAmount) : ''}
              onChange={val => onChange(prev => ({ ...prev, invoiceAmount: Number(val) }))} />
          </div>
        </div>
      </div>

      {/* 编辑时才显示开票状态和完成信息 */}
      {isEdit && (
        <div>
          <h4 className="text-sm font-medium text-gray-600 mb-2">开票状态</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">状态</label>
              <Select placeholder="请选择" value={form.status || undefined}
                onChange={val => onChange(prev => ({ ...prev, status: val as InvoiceRecord['status'] }))}
                options={Object.keys(INVOICE_STATUS_MAP).map(v => ({ label: v, value: v }))}
                popupProps={{ attach: 'body' }} />
            </div>
            {form.status === '已开票' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">开票完成时间</label>
                <input type="datetime-local" className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                  value={form.completedTime || ''} onChange={e => onChange(prev => ({ ...prev, completedTime: e.target.value }))} />
              </div>
            )}
          </div>
          {form.status === '已开票' && form.invoiceFiles && form.invoiceFiles.length > 0 && (
            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1">已上传电子发票（{form.invoiceFiles.length}张）</label>
              <InvoiceImagePreview files={form.invoiceFiles} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 详情弹窗中展示发票图片 */
function InvoiceImagePreview({ files }: { files: InvoiceFile[] }) {
  const [urls, setUrls] = useState<Array<{ fileID: string; tempFileURL: string; fileName: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchUrls = async () => {
      try {
        const fileIDs = files.map(f => f.fileID);
        const result = await getCloudFileURLs(fileIDs);
        if (!cancelled) {
          setUrls(result.map((u, i) => ({
            ...u,
            fileName: files[i]?.fileName || `图片${i + 1}`,
          })));
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUrls();
    return () => { cancelled = true; };
  }, [files]);

  if (loading) return <span className="text-xs text-gray-400">加载中...</span>;
  if (urls.length === 0) return <span className="text-xs text-gray-400">暂无图片</span>;

  return (
    <div className="flex gap-2 flex-wrap">
      {urls.map((item, i) => (
        <img
          key={i}
          src={item.tempFileURL}
          alt={item.fileName}
          className="w-20 h-20 object-contain border rounded"
        />
      ))}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  const display = value === undefined || value === null || value === '' || value === 0 ? '-' : value;
  return (
    <div className="flex py-1.5 border-b border-gray-50">
      <span className="w-32 text-gray-500 flex-shrink-0">{label}</span>
      <div className="text-gray-800">{display}</div>
    </div>
  );
}
