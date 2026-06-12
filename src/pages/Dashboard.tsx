import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownCircle, ArrowUpCircle, Smartphone, Package, Warehouse } from 'lucide-react';
import { useStats } from '../hooks/useStats';

interface QuickStat {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

export function Dashboard() {
  const navigate = useNavigate();
  const { fetchStatsData, loading } = useStats();
  const [stats, setStats] = useState<QuickStat[]>([]);

  useEffect(() => {
    fetchStatsData(7).then(data => {
      if (data) {
        setStats([
          {
            title: '入库记录',
            value: data.totalInbound,
            icon: <ArrowDownCircle size={24} />,
            color: 'text-success',
            bgColor: 'bg-success/10',
          },
          {
            title: '出库记录',
            value: data.totalOutbound,
            icon: <ArrowUpCircle size={24} />,
            color: 'text-danger',
            bgColor: 'bg-danger/10',
          },
          {
            title: '入库手机数',
            value: data.totalPhones,
            icon: <Smartphone size={24} />,
            color: 'text-primary',
            bgColor: 'bg-primary/10',
          },
          {
            title: '出库手机数',
            value: data.totalOutboundPhones,
            icon: <Package size={24} />,
            color: 'text-warning',
            bgColor: 'bg-warning/10',
          },
        ]);
      }
    });
  }, [fetchStatsData]);

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">仪表盘</h1>
        <p className="text-gray-500 mt-1">最近 7 天数据概览</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((stat) => (
          <div key={stat.title} className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{stat.title}</p>
                <p className="text-3xl font-bold mt-2 text-gray-800">
                  {loading ? '-' : stat.value}
                </p>
              </div>
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bgColor} ${stat.color}`}>
                {stat.icon}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 快捷操作 */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">快捷操作</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: '入库记录', path: '/inbound', icon: <ArrowDownCircle size={20} />, color: 'bg-success' },
            { label: '出库记录', path: '/outbound', icon: <ArrowUpCircle size={20} />, color: 'bg-danger' },
            { label: '统计分析', path: '/stats', icon: <Package size={20} />, color: 'bg-primary' },
            { label: '库存管理', path: '/inventory', icon: <Warehouse size={20} />, color: 'bg-purple-500' },
            { label: '型号管理', path: '/models', icon: <Smartphone size={20} />, color: 'bg-warning' },
          ].map(item => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className="flex flex-col items-center gap-2 p-4 rounded-xl hover:bg-gray-50 cursor-pointer"
            >
              <div className={`w-10 h-10 ${item.color} rounded-xl flex items-center justify-center text-white`}>
                {item.icon}
              </div>
              <span className="text-sm text-gray-600">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 趋势图占位 */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">租赁趋势（近7天）</h2>
        <p className="text-gray-400 text-sm">详细趋势图表请前往统计分析页面查看</p>
        <button
          onClick={() => navigate('/stats')}
          className="mt-3 text-primary text-sm hover:underline"
        >
          查看详细统计 →
        </button>
      </div>
    </div>
  );
}
