import { useEffect, useState, useRef } from 'react';
import { Table, Button, Input, Select, Tag, Dialog, MessagePlugin, Textarea } from 'tdesign-react';
import { Search, RotateCcw, Upload, Download, Plus, Pencil, Trash2 } from 'lucide-react';
import { OrderRecord, OrderFilters, ORDER_TYPE_MAP, ORDER_SOURCE_MAP, ORDER_ATTRIBUTE_MAP, SALES_CHANNEL_MAP, ORDER_STATUS_MAP, CHANNEL_CATEGORY_MAP } from '../types';
import { useOrders } from '../hooks/useOrders';
import { formatDate } from '../utils/format';
import { parseOrderExcel, exportOrderExcel } from '../utils/orderExcel';
import { BRANDS, getProductsByBrand, getSpecsByProduct, PAYMENT_ACCOUNTS, SALESPERSONS } from '../data/productDict';

/** 新增订单表单默认值 */
const EMPTY_ORDER: Omit<OrderRecord, '_id' | 'createTime'> = {
  serialNumber: 0,
  date: '',
  orderSource: '',
  orderAttribute: '',
  orderType: '',
  salesChannel: '',
  salesperson: '',
  channelCategory: '',
  onlineOrderNumber: '',
  customerName: '',
  brand: '',
  productName: '',
  specification: '',
  quantity: 0,
  unitPrice: 0,
  amount: 0,
  paymentAccount: '',
  trackingNumber: '',
  consignee: '',
  status: '--',
  customerRemark: '',
  transferProductName: '',
  transferSpecification: '',
  paidPeriod: 0,
  paidRent: 0,
};

const STATUS_TAG_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  '已发货': 'success',
  '未发货': 'warning',
  '--': 'default',
};

export function Orders() {
  const orders = useOrders();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<OrderFilters>({});
  const [detailVisible, setDetailVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<OrderRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPreviewVisible, setImportPreviewVisible] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<OrderRecord[]>([]);
  const [addVisible, setAddVisible] = useState(false);
  const [addForm, setAddForm] = useState<Omit<OrderRecord, '_id' | 'createTime'>>(EMPTY_ORDER);
  const [saving, setSaving] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editForm, setEditForm] = useState<Omit<OrderRecord, '_id' | 'createTime'>>(EMPTY_ORDER);
  const [editId, setEditId] = useState('');
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrderRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    orders.fetchRecords();
  }, []);

  const handleSearch = () => {
    orders.resetFilters();
    const searchFilters: OrderFilters = { ...filters };
    // trim 字符串字段，避免前后空格导致查不到
    if (searchFilters.customerName) searchFilters.customerName = searchFilters.customerName.trim();
    if (searchFilters.onlineOrderNumber) searchFilters.onlineOrderNumber = searchFilters.onlineOrderNumber.trim();
    orders.fetchRecords(null, searchFilters);
  };

  const handleReset = () => {
    setFilters({});
    orders.resetFilters();
    orders.fetchRecords(null, {});
  };

  const handleDetail = (record: OrderRecord) => {
    setCurrentRecord(record);
    setDetailVisible(true);
  };

  /** 导入 Excel */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const records = await parseOrderExcel(file);
      if (records.length === 0) {
        MessagePlugin.warning('未在文件中找到订单数据');
        return;
      }
      setImportPreviewData(records);
      setImportPreviewVisible(true);
    } catch (err) {
      MessagePlugin.error('文件解析失败: ' + String(err));
    }
    // 重置 input，允许再次选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImportConfirm = async () => {
    setImporting(true);
    try {
      const result = await orders.importOrders(importPreviewData);
      if (result.success) {
        MessagePlugin.success(`成功导入 ${importPreviewData.length} 条订单`);
        setImportPreviewVisible(false);
        setImportPreviewData([]);
      } else {
        MessagePlugin.error('导入失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('导入异常: ' + String(err));
    } finally {
      setImporting(false);
    }
  };

  /** 导出 Excel */
  const handleExport = () => {
    const allRecords = orders.getAllRecords();
    if (allRecords.length === 0) {
      MessagePlugin.warning('暂无数据可导出');
      return;
    }
    exportOrderExcel(allRecords);
    MessagePlugin.success(`已导出 ${allRecords.length} 条订单`);
  };

  /** 新增订单 */
  const handleAddOpen = () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    setAddForm({ ...EMPTY_ORDER, date: dateStr });
    setAddVisible(true);
  };

  const handleAddSave = async () => {
    if (!addForm.date) {
      MessagePlugin.warning('请填写日期');
      return;
    }
    if (!addForm.customerName.trim()) {
      MessagePlugin.warning('请填写客户名称');
      return;
    }
    setSaving(true);
    try {
      const newRecord: OrderRecord = {
        _id: `manual_${Date.now()}`,
        ...addForm,
      };
      const result = await orders.importOrders([newRecord]);
      if (result.success) {
        MessagePlugin.success('新增订单成功');
        setAddVisible(false);
        setAddForm(EMPTY_ORDER);
      } else {
        MessagePlugin.error('新增失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 编辑订单 */
  const handleEditOpen = (record: OrderRecord) => {
    setEditId(record._id);
    setEditForm({
      serialNumber: record.serialNumber,
      date: record.date,
      orderSource: record.orderSource,
      orderAttribute: record.orderAttribute,
      orderType: record.orderType,
      salesChannel: record.salesChannel,
      salesperson: record.salesperson,
      channelCategory: record.channelCategory,
      onlineOrderNumber: record.onlineOrderNumber,
      customerName: record.customerName,
      brand: record.brand,
      productName: record.productName,
      specification: record.specification,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      amount: record.amount,
      paymentAccount: record.paymentAccount,
      trackingNumber: record.trackingNumber,
      consignee: record.consignee,
      status: record.status,
      customerRemark: record.customerRemark,
      transferProductName: record.transferProductName,
      transferSpecification: record.transferSpecification,
      paidPeriod: record.paidPeriod,
      paidRent: record.paidRent,
    });
    setEditVisible(true);
  };

  const handleEditSave = async () => {
    if (!editForm.date) {
      MessagePlugin.warning('请填写日期');
      return;
    }
    if (!editForm.customerName.trim()) {
      MessagePlugin.warning('请填写客户名称');
      return;
    }
    setSaving(true);
    try {
      const success = await orders.updateOrder(editId, editForm);
      if (success) {
        MessagePlugin.success('修改订单成功');
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

  /** 删除订单 */
  const handleDeleteConfirm = (record: OrderRecord) => {
    setDeleteTarget(record);
    setDeleteConfirmVisible(true);
  };

  const handleDeleteExec = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const success = await orders.deleteOrder(deleteTarget._id);
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
    { colKey: 'serialNumber', title: '序号', width: 60 },
    { colKey: 'date', title: '日期', width: 100, cell: ({ row }: { row: OrderRecord }) => formatDate(row.date, false) },
    { colKey: 'orderType', title: '订单类型', width: 90, cell: ({ row }: { row: OrderRecord }) => row.orderType || '-' },
    { colKey: 'salesChannel', title: '销售渠道', width: 90, cell: ({ row }: { row: OrderRecord }) => row.salesChannel || '-' },
    { colKey: 'salesperson', title: '人员', width: 60, cell: ({ row }: { row: OrderRecord }) => row.salesperson || '-' },
    { colKey: 'customerName', title: '客户名称', width: 100, ellipsis: true },
    {
      colKey: 'productInfo', title: '货品名称/规格', width: 160,
      cell: ({ row }: { row: OrderRecord }) => {
        const name = row.productName || '';
        const spec = row.specification && row.specification !== '默认' ? ` ${row.specification}` : '';
        return name ? `${name}${spec}` : '-';
      },
    },
    { colKey: 'quantity', title: '数量', width: 60, cell: ({ row }: { row: OrderRecord }) => row.quantity || '-' },
    { colKey: 'amount', title: '金额', width: 80, cell: ({ row }: { row: OrderRecord }) => row.amount ? `¥${row.amount}` : '-' },
    {
      colKey: 'status', title: '订单状态', width: 80,
      cell: ({ row }: { row: OrderRecord }) => {
        const theme = STATUS_TAG_THEME[row.status] || 'default';
        return <Tag theme={theme} variant="light">{row.status || '--'}</Tag>;
      },
    },
    {
      colKey: 'op', title: '操作', width: 140, fixed: 'right' as const,
      cell: ({ row }: { row: OrderRecord }) => (
        <div className="flex gap-1">
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
        </div>
      ),
    },
  ];

  const displayRecords = orders.getPageRecords(orders.currentPage);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">订单管理</h1>
          <p className="text-gray-500 mt-1">管理所有订单</p>
        </div>
        <div className="flex gap-2">
          <Button theme="primary" icon={<Plus size={16} />} onClick={handleAddOpen}>
            新增订单
          </Button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileSelect} />
          <Button theme="default" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>
            导入Excel
          </Button>
          <Button theme="default" icon={<Download size={16} />} onClick={handleExport}>
            导出Excel
          </Button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">网店订单号</label>
            <Input placeholder="请输入网店订单号" value={filters.onlineOrderNumber || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, onlineOrderNumber: val as string }))} />
          </div>
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">客户名称</label>
            <Input placeholder="请输入客户名称" value={filters.customerName || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, customerName: val as string }))} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">人员</label>
            <Select placeholder="请选择人员" value={filters.salesperson || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, salesperson: val as string }))}
              options={[{ label: '全部', value: '' }, ...SALESPERSONS.map(v => ({ label: v, value: v }))]} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">日期</label>
            <input type="date" className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              value={filters.startDate || ''}
              onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))} />
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
          loading={orders.loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
        />
        {/* 分页 */}
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <Button size="small" variant="outline" disabled={orders.currentPage <= 1}
            onClick={() => orders.setCurrentPage(orders.currentPage - 1)}>
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {orders.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!orders.hasMore}
            onClick={() => orders.fetchRecords(orders.cursor)}>
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {orders.totalRecords} 条</span>
        </div>
      </div>

      {/* 详情弹窗 */}
      <Dialog header="订单详情" visible={detailVisible} onClose={() => setDetailVisible(false)} width="700px"
        footer={<Button onClick={() => setDetailVisible(false)}>关闭</Button>}>
        {currentRecord && (
          <div className="space-y-2 text-sm">
            <DetailRow label="序号" value={currentRecord.serialNumber} />
            <DetailRow label="日期" value={formatDate(currentRecord.date, false)} />
            <DetailRow label="订单来源" value={currentRecord.orderSource} />
            <DetailRow label="订单属性" value={currentRecord.orderAttribute} />
            <DetailRow label="订单类型" value={currentRecord.orderType} />
            <DetailRow label="销售渠道" value={currentRecord.salesChannel} />
            <DetailRow label="人员" value={currentRecord.salesperson} />
            <DetailRow label="渠道类别" value={currentRecord.channelCategory} />
            <DetailRow label="网店订单号" value={currentRecord.onlineOrderNumber} />
            <DetailRow label="客户名称" value={currentRecord.customerName} />
            <DetailRow label="品牌" value={currentRecord.brand} />
            <DetailRow label="货品名称" value={currentRecord.productName} />
            <DetailRow label="规格" value={currentRecord.specification} />
            <DetailRow label="数量" value={currentRecord.quantity} />
            <DetailRow label="单价" value={currentRecord.unitPrice ? `¥${currentRecord.unitPrice}` : '-'} />
            <DetailRow label="金额" value={currentRecord.amount ? `¥${currentRecord.amount}` : '-'} />
            <DetailRow label="收款账户" value={currentRecord.paymentAccount} />
            <DetailRow label="物流单号" value={currentRecord.trackingNumber} />
            <DetailRow label="收/发货人" value={currentRecord.consignee} />
            <DetailRow label="订单状态" value={
              <Tag theme={STATUS_TAG_THEME[currentRecord.status] || 'default'} variant="light">
                {currentRecord.status || '--'}
              </Tag>
            } />
            <DetailRow label="客服备注" value={currentRecord.customerRemark} />
            <DetailRow label="转租赁2货品名称" value={currentRecord.transferProductName} />
            <DetailRow label="转租赁2规格" value={currentRecord.transferSpecification} />
            <DetailRow label="已交租期" value={currentRecord.paidPeriod || '-'} />
            <DetailRow label="已交租金" value={currentRecord.paidRent ? `¥${currentRecord.paidRent}` : '-'} />
          </div>
        )}
      </Dialog>

      {/* 导入预览弹窗 */}
      <Dialog
        header={`确认导入 (${importPreviewData.length} 条订单)`}
        visible={importPreviewVisible}
        onClose={() => { setImportPreviewVisible(false); setImportPreviewData([]); }}
        width="800px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setImportPreviewVisible(false); setImportPreviewData([]); }}>取消</Button>
            <Button theme="primary" loading={importing} onClick={handleImportConfirm}>确认导入</Button>
          </div>
        }
      >
        <div className="max-h-96 overflow-auto">
          <Table
            data={importPreviewData.slice(0, 50)}
            columns={[
              { colKey: 'serialNumber', title: '序号', width: 60 },
              { colKey: 'date', title: '日期', width: 100 },
              { colKey: 'orderType', title: '订单类型', width: 90 },
              { colKey: 'salesChannel', title: '销售渠道', width: 90 },
              { colKey: 'customerName', title: '客户', width: 100 },
              { colKey: 'productName', title: '货品名称', width: 120 },
              { colKey: 'quantity', title: '数量', width: 60 },
              { colKey: 'amount', title: '金额', width: 80 },
              { colKey: 'status', title: '状态', width: 80 },
            ]}
            rowKey="_id"
            tableLayout="fixed"
            size="small"
            stripe
          />
          {importPreviewData.length > 50 && (
            <p className="text-center text-gray-400 text-xs py-2">仅显示前 50 条，共 {importPreviewData.length} 条</p>
          )}
        </div>
      </Dialog>

      {/* 新增订单弹窗 */}
      <Dialog
        header="新增订单"
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        width="720px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddVisible(false)}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleAddSave}>保存</Button>
          </div>
        }
      >
        <OrderFormFields form={addForm} onChange={setAddForm} />
      </Dialog>

      {/* 编辑订单弹窗 */}
      <Dialog
        header="编辑订单"
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        width="720px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditVisible(false)}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleEditSave}>保存</Button>
          </div>
        }
      >
        <OrderFormFields form={editForm} onChange={setEditForm} />
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
          确定要删除客户 <span className="font-medium text-gray-900">{deleteTarget?.customerName}</span> 的订单吗？此操作不可撤销。
        </p>
      </Dialog>
    </div>
  );
}

/** 订单表单字段（新增/编辑共用） */
function OrderFormFields({ form, onChange }: {
  form: Omit<OrderRecord, '_id' | 'createTime'>;
  onChange: React.Dispatch<React.SetStateAction<Omit<OrderRecord, '_id' | 'createTime'>>>;
}) {
  return (
    <div className="space-y-4 max-h-[70vh] overflow-auto px-1">
      {/* 基础信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">基础信息</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">网店订单号</label>
            <Input placeholder="网店订单号" value={form.onlineOrderNumber}
              onChange={val => onChange(prev => ({ ...prev, onlineOrderNumber: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">日期 <span className="text-red-500">*</span></label>
            <input type="date" className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              value={form.date} onChange={e => onChange(prev => ({ ...prev, date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">客户名称 <span className="text-red-500">*</span></label>
            <Input placeholder="客户名称" value={form.customerName}
              onChange={val => onChange(prev => ({ ...prev, customerName: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">人员</label>
            <Select placeholder="请选择" value={form.salesperson || ''}
              onChange={val => onChange(prev => ({ ...prev, salesperson: val as string }))}
              options={[{ label: '请选择', value: '' }, ...SALESPERSONS.map(v => ({ label: v, value: v }))]} />
          </div>
        </div>
      </div>

      {/* 订单属性 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">订单属性</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">订单来源</label>
            <Select placeholder="请选择" value={form.orderSource || ''}
              onChange={val => onChange(prev => ({ ...prev, orderSource: val as string }))}
              options={[{ label: '请选择', value: '' }, ...Object.keys(ORDER_SOURCE_MAP).map(v => ({ label: v, value: v }))]} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">订单属性</label>
            <Select placeholder="请选择" value={form.orderAttribute || ''}
              onChange={val => onChange(prev => ({ ...prev, orderAttribute: val as string }))}
              options={[{ label: '请选择', value: '' }, ...Object.keys(ORDER_ATTRIBUTE_MAP).map(v => ({ label: v, value: v }))]} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">订单类型</label>
            <Select placeholder="请选择" value={form.orderType || ''}
              onChange={val => onChange(prev => ({ ...prev, orderType: val as string }))}
              options={[{ label: '请选择', value: '' }, ...Object.keys(ORDER_TYPE_MAP).map(v => ({ label: v, value: v }))]} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">销售渠道</label>
            <Select placeholder="请选择" value={form.salesChannel || ''}
              onChange={val => onChange(prev => ({ ...prev, salesChannel: val as string }))}
              options={[{ label: '请选择', value: '' }, ...Object.keys(SALES_CHANNEL_MAP).map(v => ({ label: v, value: v }))]} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">渠道类别</label>
            <Select placeholder="请选择" value={form.channelCategory || ''}
              onChange={val => onChange(prev => ({ ...prev, channelCategory: val as string }))}
              options={[{ label: '请选择', value: '' }, ...Object.keys(CHANNEL_CATEGORY_MAP).map(v => ({ label: v, value: v }))]} />
          </div>
        </div>
      </div>

      {/* 货品信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">货品信息</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">品牌</label>
            <Select placeholder="请选择品牌" value={form.brand || ''}
              onChange={val => onChange(prev => ({
                ...prev,
                brand: val as string,
                productName: '',
                specification: '',
              }))}
              options={[{ label: '请选择', value: '' }, ...BRANDS.map(v => ({ label: v, value: v }))]}
              filterable />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">货品名称</label>
            <Select placeholder="请先选择品牌" value={form.productName || ''}
              onChange={val => onChange(prev => ({
                ...prev,
                productName: val as string,
                specification: '',
              }))}
              options={[{ label: '请选择', value: '' }, ...getProductsByBrand(form.brand).map(v => ({ label: v, value: v }))]}
              filterable />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">规格</label>
            <Select placeholder="请先选择货品" value={form.specification || ''}
              onChange={val => onChange(prev => ({ ...prev, specification: val as string }))}
              options={[{ label: '请选择', value: '' }, ...getSpecsByProduct(form.brand, form.productName).map(v => ({ label: v, value: v }))]} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">数量</label>
            <Input type="number" placeholder="数量" value={form.quantity ? String(form.quantity) : ''}
              onChange={val => {
                const q = Number(val);
                onChange(prev => ({ ...prev, quantity: q, amount: q * prev.unitPrice }));
              }} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">单价</label>
            <Input type="number" placeholder="单价" value={form.unitPrice ? String(form.unitPrice) : ''}
              onChange={val => {
                const p = Number(val);
                onChange(prev => ({ ...prev, unitPrice: p, amount: prev.quantity * p }));
              }} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">金额</label>
            <Input type="number" placeholder="数量×单价自动计算" value={form.amount ? String(form.amount) : ''} readonly />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">收款账户</label>
            <Select placeholder="请选择" value={form.paymentAccount || ''}
              onChange={val => onChange(prev => ({ ...prev, paymentAccount: val as string }))}
              options={[{ label: '请选择', value: '' }, ...PAYMENT_ACCOUNTS.map(v => ({ label: v, value: v }))]} />
          </div>
        </div>
      </div>

      {/* 物流信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">物流信息</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">物流单号</label>
            <Input placeholder="物流单号" value={form.trackingNumber}
              onChange={val => onChange(prev => ({ ...prev, trackingNumber: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">收/发货人</label>
            <Input placeholder="收/发货人" value={form.consignee}
              onChange={val => onChange(prev => ({ ...prev, consignee: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">订单状态</label>
            <Select placeholder="请选择" value={form.status || ''}
              onChange={val => onChange(prev => ({ ...prev, status: val as string }))}
              options={Object.keys(ORDER_STATUS_MAP).map(v => ({ label: v, value: v }))} />
          </div>
        </div>
      </div>

      {/* 转租赁 & 备注 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">转租赁 & 备注</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">转租赁2货品名称</label>
            <Input placeholder="转租赁2货品名称" value={form.transferProductName}
              onChange={val => onChange(prev => ({ ...prev, transferProductName: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">转租赁2规格</label>
            <Input placeholder="转租赁2规格" value={form.transferSpecification}
              onChange={val => onChange(prev => ({ ...prev, transferSpecification: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">已交租期</label>
            <Input type="number" placeholder="已交租期" value={form.paidPeriod ? String(form.paidPeriod) : ''}
              onChange={val => onChange(prev => ({ ...prev, paidPeriod: Number(val) }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">已交租金</label>
            <Input type="number" placeholder="已交租金" value={form.paidRent ? String(form.paidRent) : ''}
              onChange={val => onChange(prev => ({ ...prev, paidRent: Number(val) }))} />
          </div>
          <div className="col-span-3">
            <label className="block text-xs text-gray-500 mb-1">客服备注</label>
            <Textarea placeholder="客服备注" value={form.customerRemark}
              onChange={val => onChange(prev => ({ ...prev, customerRemark: val as string }))} />
          </div>
        </div>
      </div>
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
