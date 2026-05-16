import { useEffect, useState } from 'react';
import { Table, Button, Input, MessagePlugin, Dialog } from 'tdesign-react';
import { Search, RotateCcw } from 'lucide-react';
import { OutboundRecord, OutboundFilters } from '../types';
import { useOutbound } from '../hooks/useOutbound';
import { useLogs } from '../hooks/useLogs';
import { useStorage } from '../hooks/useStorage';
import { formatDate, getTotalQuantity } from '../utils/format';
import { RecordDetail } from '../components/RecordDetail';
import { RecordEdit } from '../components/RecordEdit';

export function OutboundList() {
  const outbound = useOutbound();
  const logs = useLogs();
  const { notifyRecordChange } = useStorage();

  const [detailVisible, setDetailVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<OutboundRecord | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [filters, setFilters] = useState<OutboundFilters>({});

  useEffect(() => {
    outbound.fetchRecords();
  }, []);

  const handleSearch = () => {
    outbound.resetFilters();
    outbound.fetchRecords(null, filters);
  };

  const handleReset = () => {
    setFilters({});
    outbound.resetFilters();
    outbound.fetchRecords(null, {});
  };

  const handleDetail = (record: OutboundRecord) => {
    setCurrentRecord(record);
    setDetailVisible(true);
  };

  const handleEdit = () => {
    setDetailVisible(false);
    setEditVisible(true);
  };

  const handleSave = async (recordId: string, updateData: Record<string, unknown>) => {
    const success = await outbound.updateRecord(recordId, updateData as Partial<OutboundRecord>);
    if (success) {
      const logResult = await logs.saveOperationLog('update', 'outbound', recordId, updateData.customerName as string, '网页用户');
      await notifyRecordChange('update', 'outbound', { ...currentRecord, ...updateData } as Record<string, unknown>, logResult?._id);
      outbound.fetchRecords(null, outbound.filters);
    }
    return success;
  };

  const handleDelete = async () => {
    if (!currentRecord) return;
    const success = await outbound.deleteRecord(currentRecord._id);
    if (success) {
      await logs.saveOperationLog('delete', 'outbound', currentRecord._id, currentRecord.customerName, '网页用户');
      await notifyRecordChange('delete', 'outbound', currentRecord as unknown as Record<string, unknown>);
      MessagePlugin.success('删除成功');
      setDeleteConfirmVisible(false);
      setDetailVisible(false);
      outbound.fetchRecords(null, outbound.filters);
    } else {
      MessagePlugin.error('删除失败');
    }
  };

  const columns = [
    { colKey: 'outboundDate', title: '出库日期', width: 110, cell: ({ row }: { row: OutboundRecord }) => formatDate(row.outboundDate, false) },
    { colKey: 'customerName', title: '客户名称', width: 140, ellipsis: true },
    { colKey: 'trackingNumber', title: '快递单号', width: 140, cell: ({ row }: { row: OutboundRecord }) => row.trackingNumber || '-' },
    { colKey: 'phoneModels', title: '手机型号', width: 200, cell: ({ row }: { row: OutboundRecord }) =>
      row.phoneModels?.map(m => `${m.model} x${m.quantity}`).join(', ') || '-'
    },
    { colKey: 'totalQuantity', title: '数量', width: 70, cell: ({ row }: { row: OutboundRecord }) => getTotalQuantity(row) },
    { colKey: 'hasIssue', title: '异常', width: 60, cell: ({ row }: { row: OutboundRecord }) =>
      row.hasIssue ? <span className="text-danger">是</span> : <span className="text-gray-400">否</span>
    },
    {
      colKey: 'op', title: '操作', width: 80, fixed: 'right' as const,
      cell: ({ row }: { row: OutboundRecord }) => (
        <Button variant="text" theme="primary" size="small" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetail(row); }}>
          详情
        </Button>
      ),
    },
  ];

  const displayRecords = outbound.getPageRecords(outbound.currentPage);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">出库记录</h1>
        <p className="text-gray-500 mt-1">管理所有出库记录</p>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <Input placeholder="客户名称" value={filters.customerName || ''} onChange={(val) => setFilters(prev => ({ ...prev, customerName: val as string }))} />
          <Input placeholder="快递单号" value={filters.trackingNumber || ''} onChange={(val) => setFilters(prev => ({ ...prev, trackingNumber: val as string }))} />
          <Input placeholder="手机型号" value={filters.model || ''} onChange={(val) => setFilters(prev => ({ ...prev, model: val as string }))} />
          <input type="date" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary" placeholder="开始日期" value={filters.startDate || ''} onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))} />
          <input type="date" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary" placeholder="结束日期" value={filters.endDate || ''} onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))} />
          <div className="flex gap-2">
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
          loading={outbound.loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
          onRowClick={({ row }) => handleDetail(row as OutboundRecord)}
        />
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <span className="text-sm text-gray-500">第 {outbound.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!outbound.hasMore}
            onClick={() => outbound.fetchRecords(outbound.cursor)}>
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {outbound.totalRecords} 条</span>
        </div>
      </div>

      {/* 详情弹窗 */}
      <RecordDetail
        visible={detailVisible}
        record={currentRecord}
        type="outbound"
        onClose={() => setDetailVisible(false)}
        onEdit={handleEdit}
        onDelete={() => setDeleteConfirmVisible(true)}
      />

      {/* 编辑弹窗 */}
      <RecordEdit
        visible={editVisible}
        record={currentRecord}
        type="outbound"
        onClose={() => setEditVisible(false)}
        onSave={handleSave}
      />

      {/* 删除确认 */}
      <Dialog
        header="确认删除"
        visible={deleteConfirmVisible}
        onClose={() => setDeleteConfirmVisible(false)}
        onConfirm={handleDelete}
      >
        <p>确定要删除这条出库记录吗？此操作不可撤销。</p>
      </Dialog>
    </div>
  );
}
