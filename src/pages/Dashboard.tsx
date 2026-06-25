import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  Bell,
  Package,
  RefreshCw,
  Smartphone,
  WalletCards,
} from 'lucide-react';
import { callFunction } from '../lib/cloudbase';
import { OrderFilters, OrderRecord } from '../types';
import { formatDate } from '../utils/format';

interface QuickStat {
  title: string;
  value: number | null;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

type MessageType = 'return' | 'payment';

interface DynamicMessage {
  id: string;
  type: MessageType;
  title: string;
  detail: string;
  date: string;
  orderId: string;
  onlineOrderNumber: string;
  customerName: string;
}

interface ShipmentTrendItem {
  date: string;
  发货数量: number;
  发货台数: number;
}

interface TopShippedModelItem {
  model: string;
  发货台数: number;
}

interface DailyShipmentStats {
  statDate: string;
  startDate: string;
  endDate: string;
  shipmentTrend: ShipmentTrendItem[];
  topShippedModels: TopShippedModelItem[];
  totalInbound: number;
  totalPhones: number;
  totalOutbound: number;
  totalOutboundPhones: number;
}

interface QueryOrdersResult {
  data?: OrderRecord[];
  cursor?: string | null;
  hasMore?: boolean;
}

const DYNAMIC_MESSAGE_PAGE_SIZE = 100;
const DYNAMIC_MESSAGE_MAX_SCAN = 10000;
const DYNAMIC_MESSAGE_DISPLAY_LIMIT = 20;

const RETURN_STATUS_LABELS: Record<string, string> = {
  returned: '产品已退回入库',
  inTransit: '产品运输途中',
  notReturned: '客户未退回',
};

const DEFAULT_STATS: QuickStat[] = [
  {
    title: '入库记录',
    value: null,
    icon: <ArrowDownCircle size={24} />,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  {
    title: '出库记录',
    value: null,
    icon: <ArrowUpCircle size={24} />,
    color: 'text-danger',
    bgColor: 'bg-danger/10',
  },
  {
    title: '入库手机数',
    value: null,
    icon: <Smartphone size={24} />,
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  {
    title: '出库手机数',
    value: null,
    icon: <Package size={24} />,
    color: 'text-warning',
    bgColor: 'bg-warning/10',
  },
];

const getOrderTime = (order: OrderRecord) => {
  const time = order.date || order.createTime?.$date || '';
  return time;
};

const buildOrderLabel = (order: OrderRecord) => {
  const parts = [
    order.customerName,
    order.onlineOrderNumber ? `订单号 ${order.onlineOrderNumber}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '未命名订单';
};

const buildOwnerLabel = (order: OrderRecord) => `责任人 ${order.salesperson || '-'}`;

async function fetchOrdersForDynamicMessages() {
  const orders: OrderRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore && orders.length < DYNAMIC_MESSAGE_MAX_SCAN) {
    const result: QueryOrdersResult = await callFunction<QueryOrdersResult>('queryOrders', {
      data: { limit: DYNAMIC_MESSAGE_PAGE_SIZE, cursor },
    });
    const pageData = result.data || [];
    orders.push(...pageData);
    cursor = result.cursor || null;
    hasMore = !!result.hasMore && !!cursor && pageData.length > 0;
  }

  return orders;
}

export function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<QuickStat[]>(DEFAULT_STATS);
  const [statsReady, setStatsReady] = useState(false);
  const [shipmentTrend, setShipmentTrend] = useState<ShipmentTrendItem[]>([]);
  const [topShippedModels, setTopShippedModels] = useState<TopShippedModelItem[]>([]);
  const [dailyStatsLoading, setDailyStatsLoading] = useState(false);
  const [dailyStatsRange, setDailyStatsRange] = useState('');
  const [messages, setMessages] = useState<DynamicMessage[]>([]);
  const [messageCounts, setMessageCounts] = useState({ return: 0, payment: 0 });
  const [messagesLoading, setMessagesLoading] = useState(false);

  const loadDailyShipmentStats = async () => {
    setDailyStatsLoading(true);
    try {
      const result = await callFunction<{ success?: boolean; data?: DailyShipmentStats | null }>('queryDailyShipmentStats');
      const data = result.data;
      setShipmentTrend(data?.shipmentTrend || []);
      setTopShippedModels(data?.topShippedModels || []);
      setDailyStatsRange(data?.startDate && data?.endDate ? `${data.startDate} 至 ${data.endDate}` : '');
      if (data) {
        setStats([
          {
            title: '入库记录',
            value: data.totalInbound || 0,
            icon: DEFAULT_STATS[0].icon,
            color: DEFAULT_STATS[0].color,
            bgColor: DEFAULT_STATS[0].bgColor,
          },
          {
            title: '出库记录',
            value: data.totalOutbound || 0,
            icon: DEFAULT_STATS[1].icon,
            color: DEFAULT_STATS[1].color,
            bgColor: DEFAULT_STATS[1].bgColor,
          },
          {
            title: '入库手机数',
            value: data.totalPhones || 0,
            icon: DEFAULT_STATS[2].icon,
            color: DEFAULT_STATS[2].color,
            bgColor: DEFAULT_STATS[2].bgColor,
          },
          {
            title: '出库手机数',
            value: data.totalOutboundPhones || 0,
            icon: DEFAULT_STATS[3].icon,
            color: DEFAULT_STATS[3].color,
            bgColor: DEFAULT_STATS[3].bgColor,
          },
        ]);
      } else {
        setStats(DEFAULT_STATS);
      }
      setStatsReady(!!data);
    } catch (err) {
      console.error('获取日切发货统计失败:', err);
      setShipmentTrend([]);
      setTopShippedModels([]);
      setDailyStatsRange('');
      setStats(DEFAULT_STATS);
      setStatsReady(false);
    } finally {
      setDailyStatsLoading(false);
    }
  };

  const loadDynamicMessages = async () => {
    setMessagesLoading(true);
    try {
      const orders = await fetchOrdersForDynamicMessages();
      const returnMessages = orders
        .filter(order => ['postRentalShip', 'postRentalReturn'].includes(order.orderType))
        .filter(order => order.returnStatus !== 'returned')
        .map((order): DynamicMessage => ({
          id: `${order._id}-return`,
          type: 'return',
          title: '归还状态待处理',
          detail: `${buildOrderLabel(order)} · ${buildOwnerLabel(order)} · ${RETURN_STATUS_LABELS[order.returnStatus || ''] || '未填写归还状态'}`,
          date: getOrderTime(order),
          orderId: order._id,
          onlineOrderNumber: order.onlineOrderNumber || '',
          customerName: order.customerName || '',
        }));

      const paymentMessages = orders
        .filter(order => order.paymentAccount === '未收款')
        .map((order): DynamicMessage => ({
          id: `${order._id}-payment`,
          type: 'payment',
          title: '订单待收款',
          detail: `${buildOrderLabel(order)} · ${buildOwnerLabel(order)} · 金额 ¥${order.amount || 0}`,
          date: getOrderTime(order),
          orderId: order._id,
          onlineOrderNumber: order.onlineOrderNumber || '',
          customerName: order.customerName || '',
        }));

      setMessageCounts({
        return: returnMessages.length,
        payment: paymentMessages.length,
      });

      const nextMessages = [...returnMessages, ...paymentMessages]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, DYNAMIC_MESSAGE_DISPLAY_LIMIT);

      setMessages(nextMessages);
    } catch (err) {
      console.error('获取首页动态消息失败:', err);
      setMessages([]);
      setMessageCounts({ return: 0, payment: 0 });
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleMessageClick = (message: DynamicMessage) => {
    const filter: OrderFilters = {};
    if (message.onlineOrderNumber) {
      filter.onlineOrderNumber = message.onlineOrderNumber;
    } else if (message.customerName) {
      filter.customerName = message.customerName;
    }
    navigate('/orders', { state: { filter } });
  };

  useEffect(() => {
    loadDailyShipmentStats();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchDynamicMessages = async () => {
      setMessagesLoading(true);
      try {
        await loadDynamicMessages();
      } catch (err) {
        console.error('获取首页动态消息失败:', err);
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    };

    fetchDynamicMessages();
    const timer = window.setInterval(fetchDynamicMessages, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const returnMessageCount = messageCounts.return;
  const paymentMessageCount = messageCounts.payment;
  const shouldRollMessages = messages.length > 4;
  const rollingMessages = shouldRollMessages ? [...messages, ...messages] : messages;
  const rollDuration = `${Math.max(18, messages.length * 3)}s`;
  const statsRangeText = dailyStatsRange ? `统计区间：${dailyStatsRange}` : '等待每日 0 点日切统计生成';

  const messagePanel = (
    <div className="glass-card overflow-hidden lg:sticky lg:top-6">
      <div className="border-b border-gray-100 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800">
              <Bell size={20} className="text-primary" />
              动态消息
            </h2>
            <p className="mt-1 text-sm text-gray-500">需要优先跟进的订单</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={loadDynamicMessages}
              disabled={messagesLoading}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={14} className={messagesLoading ? 'animate-spin' : ''} />
              刷新
            </button>
            <button
              onClick={() => navigate('/orders')}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90"
            >
              <Bell size={14} />
              查看订单
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-orange-50 px-3 py-2 text-orange-700">
            <div className="text-xl font-semibold">{returnMessageCount}</div>
            <div className="text-xs">未退回入库</div>
          </div>
          <div className="rounded-lg bg-red-50 px-3 py-2 text-red-700">
            <div className="text-xl font-semibold">{paymentMessageCount}</div>
            <div className="text-xs">未收款</div>
          </div>
        </div>
      </div>

      <div className="h-[34rem] overflow-hidden p-3">
        {messagesLoading && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">正在加载动态消息...</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-gray-400">
            <Bell size={28} />
            暂无需要跟进的订单
          </div>
        ) : (
          <div
            className={shouldRollMessages ? 'dashboard-message-roll space-y-1.5' : 'space-y-1.5'}
            style={shouldRollMessages ? { '--message-roll-duration': rollDuration } as React.CSSProperties : undefined}
          >
            {rollingMessages.map((message, index) => (
              <button
                key={`${message.id}-${index}`}
                onClick={() => handleMessageClick(message)}
                className="flex w-full items-start gap-2.5 rounded-lg border border-gray-100 bg-white px-3 py-2 text-left shadow-sm hover:border-primary/30 hover:bg-primary/5"
              >
                <div className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
                  message.type === 'return' ? 'bg-orange-50 text-orange-600' : 'bg-red-50 text-red-600'
                }`}>
                  {message.type === 'return' ? <AlertCircle size={16} /> : <WalletCards size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-gray-800">{message.title}</p>
                    <span className="flex-shrink-0 text-xs text-gray-400">{formatDate(message.date, false)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-gray-500">{message.detail}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-6">
        {/* 标题 */}
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">首页</h1>
          <p className="text-gray-500 mt-1">{statsRangeText}</p>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.title} className="stat-card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{stat.title}</p>
                  {dailyStatsLoading || !statsReady || stat.value === null ? (
                    <div className="mt-3 h-10 w-24 animate-pulse rounded-md bg-gray-100" />
                  ) : (
                    <p className="text-3xl font-bold mt-2 text-gray-800">{stat.value}</p>
                  )}
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bgColor} ${stat.color}`}>
                  {stat.icon}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="xl:hidden">
          {messagePanel}
        </div>

        {/* 发货统计 */}
        <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
          <div className="glass-card p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-800">近 7 日发货统计</h2>
              <p className="mt-1 text-sm text-gray-500">{statsRangeText}</p>
            </div>
            {dailyStatsLoading ? (
              <div className="h-72 animate-pulse rounded-lg bg-gray-50" />
            ) : shipmentTrend.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-gray-400">暂无日切发货统计数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={288}>
                <BarChart data={shipmentTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="date" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="发货数量" fill="#4787F0" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="发货台数" fill="#00A870" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="glass-card p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-800">近 7 日发货型号 TOP 5</h2>
              <p className="mt-1 text-sm text-gray-500">{statsRangeText}</p>
            </div>
            {dailyStatsLoading ? (
              <div className="h-72 animate-pulse rounded-lg bg-gray-50" />
            ) : topShippedModels.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-gray-400">暂无日切发货型号数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={288}>
                <BarChart data={topShippedModels} margin={{ top: 8, right: 12, left: 0, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis
                    dataKey="model"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={52}
                  />
                  <YAxis fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="发货台数" fill="#ED7B2F" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="hidden xl:block">
        {messagePanel}
      </div>
    </div>
  );
}
