import { useState } from 'react';
import { Button, Table, Loading } from 'tdesign-react';
import { Search } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useStats } from '../hooks/useStats';
import { ModelStatsItem } from '../types';

export function Stats() {
  const { loading, fetchStatsData, fetchModelStats, modelStats } = useStats();
  const [statsDate, setStatsDate] = useState('');
  const [chartData, setChartData] = useState<Array<Record<string, unknown>>>([]);

  const handleLoadChart = async () => {
    const data = await fetchStatsData(7);
    if (data) {
      setChartData(data.dates.map((date, i) => ({
        date,
        入库记录: data.inboundCounts[i],
        入库手机: data.inboundPhones[i],
        出库记录: data.outboundCounts[i],
        出库手机: data.outboundPhones[i],
      })));
    }
  };

  const handleModelStats = async () => {
    if (!statsDate) return;
    await fetchModelStats(statsDate);
  };

  const modelColumns = [
    { colKey: 'model', title: '手机型号', ellipsis: true },
    { colKey: 'inbound', title: '入库数量', width: 100, cell: ({ row }: { row: ModelStatsItem }) => (
      <span className="text-success font-medium">{row.inbound}</span>
    )},
    { colKey: 'outbound', title: '出库数量', width: 100, cell: ({ row }: { row: ModelStatsItem }) => (
      <span className="text-danger font-medium">{row.outbound}</span>
    )},
    { colKey: 'change', title: '变动', width: 80, cell: ({ row }: { row: ModelStatsItem }) => (
      <span className={row.change > 0 ? 'text-success' : row.change < 0 ? 'text-danger' : 'text-gray-400'}>
        {row.change > 0 ? '+' : ''}{row.change}
      </span>
    )},
    { colKey: 'inboundOrders', title: '入库订单', width: 100 },
    { colKey: 'outboundOrders', title: '出库订单', width: 100 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">统计分析</h1>
        <p className="text-gray-500 mt-1">出入库数据统计与趋势</p>
      </div>

      {/* 趋势图 */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">出入库趋势（近7天）</h2>
          <Button theme="primary" icon={<Search size={16} />} onClick={handleLoadChart} loading={loading}>
            加载趋势
          </Button>
        </div>

        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="入库手机" stroke="#00A870" strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="出库手机" stroke="#E34D59" strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="入库记录" stroke="#4787F0" strokeWidth={2} strokeDasharray="5 5" />
              <Line type="monotone" dataKey="出库记录" stroke="#ED7B2F" strokeWidth={2} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[300px] text-gray-400">
            点击"加载趋势"查看近7天数据
          </div>
        )}
      </div>

      {/* 按型号统计 */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-gray-800">按手机型号统计</h2>
          <input
            type="date"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary"
            value={statsDate}
            onChange={(e) => setStatsDate(e.target.value)}
          />
          <Button theme="primary" onClick={handleModelStats} loading={loading}>查询</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Loading /></div>
        ) : modelStats && modelStats.length > 0 ? (
          <Table data={modelStats} columns={modelColumns} rowKey="model" stripe hover />
        ) : (
          <p className="text-center text-gray-400 py-8">请选择日期查询</p>
        )}

        {/* 订单数统计 */}
        {modelStats && modelStats.length > 0 && (
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="bg-success/5 rounded-xl p-4 text-center">
              <p className="text-sm text-gray-500">入库订单数</p>
              <p className="text-2xl font-bold text-success mt-1">{modelStats.reduce((sum, item) => sum + item.inboundOrders, 0)}</p>
            </div>
            <div className="bg-danger/5 rounded-xl p-4 text-center">
              <p className="text-sm text-gray-500">出库订单数</p>
              <p className="text-2xl font-bold text-danger mt-1">{modelStats.reduce((sum, item) => sum + item.outboundOrders, 0)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
