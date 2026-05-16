import { useEffect, useState } from 'react';
import { Table, Button, Input, Select, Tag, Dialog, Loading } from 'tdesign-react';
import { Search, RotateCcw } from 'lucide-react';
import { OperationLog, LogFilters } from '../types';
import { useLogs } from '../hooks/useLogs';
import { formatDate } from '../utils/format';

const OPERATION_TYPE_MAP: Record<string, { label: string; theme: 'success' | 'primary' | 'danger' }> = {
  create: { label: '创建', theme: 'success' },
  update: { label: '更新', theme: 'primary' },
  delete: { label: '删除', theme: 'danger' },
};

const LOG_TYPE_MAP: Record<string, { label: string; theme: 'success' | 'danger' }> = {
  inbound: { label: '入库', theme: 'success' },
  outbound: { label: '出库', theme: 'danger' },
};

export function Logs() {
  const { records, hasMore, total, loading, fetchLogs, fetchRecordHistory } = useLogs();
  const [filters, setFilters] = useState<LogFilters>({});
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState<unknown[]>([]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSearch = () => {
    fetchLogs(null, filters);
  };

  const handleReset = () => {
    setFilters({});
    fetchLogs(null, {});
  };

  const handleViewHistory = async (log: OperationLog) => {
    if (!log.logId) return;
    setHistoryVisible(true);
    setHistoryLoading(true);
    const result = await fetchRecordHistory(log.logId);
    if (result?.success) {
      setHistoryData(result.data || []);
    }
    setHistoryLoading(false);
  };

  const columns = [
    { colKey: 'operationTime', title: '时间', width: 140, cell: ({ row }: { row: OperationLog }) => formatDate(row.operationTime) },
    { colKey: 'operator', title: '操作人', width: 100 },
    {
      colKey: 'operationType', title: '操作类型', width: 80,
      cell: ({ row }: { row: OperationLog }) => {
        const config = OPERATION_TYPE_MAP[row.operationType];
        return config ? <Tag theme={config.theme} variant="light">{config.label}</Tag> : row.operationType;
      },
    },
    {
      colKey: 'logType', title: '日志类型', width: 80,
      cell: ({ row }: { row: OperationLog }) => {
        const config = LOG_TYPE_MAP[row.logType];
        return config ? <Tag theme={config.theme} variant="light">{config.label}</Tag> : row.logType;
      },
    },
    { colKey: 'operationContent', title: '操作内容', ellipsis: true },
    {
      colKey: 'op', title: '操作', width: 100, fixed: 'right' as const,
      cell: ({ row }: { row: OperationLog }) => (
        <Button variant="text" theme="primary" size="small" onClick={() => handleViewHistory(row)}>
          修改历史
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">操作日志</h1>
        <p className="text-gray-500 mt-1">查看系统操作记录</p>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <Input placeholder="操作人" value={filters.operator || ''} onChange={(val) => setFilters(prev => ({ ...prev, operator: val as string }))} />
          <Select
            placeholder="操作类型"
            value={filters.operationType || ''}
            onChange={(val) => setFilters(prev => ({ ...prev, operationType: val as string }))}
            options={[
              { label: '全部', value: '' },
              { label: '创建', value: 'create' },
              { label: '更新', value: 'update' },
              { label: '删除', value: 'delete' },
            ]}
          />
          <Select
            placeholder="日志类型"
            value={filters.logType || ''}
            onChange={(val) => setFilters(prev => ({ ...prev, logType: val as string }))}
            options={[
              { label: '全部', value: '' },
              { label: '入库', value: 'inbound' },
              { label: '出库', value: 'outbound' },
            ]}
          />
          <input type="date" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary" placeholder="开始日期" value={filters.startDate || ''} onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))} />
          <input type="date" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary" placeholder="结束日期" value={filters.endDate || ''} onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))} />
          <div className="flex gap-2">
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      {/* 日志表格 */}
      <div className="glass-card">
        <Table data={records} columns={columns} loading={loading} rowKey="_id" stripe hover />
        <div className="flex justify-center items-center gap-3 py-4 border-t border-gray-100">
          <span className="text-sm text-gray-400">共 {total} 条</span>
          {hasMore && (
            <Button variant="outline" size="small" onClick={() => fetchLogs(null, filters)}>加载更多</Button>
          )}
        </div>
      </div>

      {/* 修改历史弹窗 */}
      <Dialog header="修改历史" visible={historyVisible} onClose={() => setHistoryVisible(false)} width="700px" footer={null}>
        {historyLoading ? (
          <div className="flex justify-center py-8"><Loading /></div>
        ) : historyData.length === 0 ? (
          <p className="text-center text-gray-400 py-8">暂无修改历史</p>
        ) : (
          <div className="space-y-4 max-h-[60vh] overflow-auto">
            {(historyData as Array<Record<string, unknown>>).map((item, i) => (
              <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2 text-sm flex gap-4">
                  <span className="text-primary font-medium">#{i + 1}</span>
                  <span className="text-gray-500">{formatDate(item.operationTime as string)}</span>
                  <span className="text-success">{item.operator as string}</span>
                </div>
                {(item.changes as Array<Record<string, unknown>>)?.length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="px-3 py-2 text-left">字段</th>
                        <th className="px-3 py-2 text-left">旧值</th>
                        <th className="px-3 py-2 text-left">新值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(item.changes as Array<Record<string, unknown>>).map((change, j) => (
                        <tr key={j} className="border-t">
                          <td className="px-3 py-2 font-medium">{change.field as string}</td>
                          <td className="px-3 py-2 text-danger bg-red-50">
                            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(change.oldValue, null, 2)}</pre>
                          </td>
                          <td className="px-3 py-2 text-success bg-green-50">
                            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(change.newValue, null, 2)}</pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
