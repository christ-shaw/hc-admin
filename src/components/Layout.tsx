import { useState, useEffect, useCallback } from 'react';
import { Layout as TLayout, MessagePlugin } from 'tdesign-react';
import {
  Package,
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  FileText,
  Smartphone,
  Warehouse,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  LogOut,
  User,
  ShoppingCart,
  Receipt,
  Building2,
  Bell,
  ChevronDown,
  ChevronRight,
  Settings,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getCurrentUser, signOut, callFunction } from '../lib/cloudbase';
import { usePermission } from '../contexts/PermissionContext';

const { Header, Content, Aside } = TLayout;

const navItems = [
  { path: '/', label: '首页', Icon: LayoutDashboard },
  { path: '/inbound', label: '入库记录', Icon: ArrowDownCircle },
  { path: '/outbound', label: '出库记录', Icon: ArrowUpCircle },
  { path: '/inventory', label: '库存管理', Icon: Warehouse },
  { path: '/stats', label: '统计分析', Icon: BarChart3 },
  { path: '/logs', label: '操作日志', Icon: FileText },
  { path: '/models', label: '型号管理', Icon: Smartphone },
  { path: '/orders', label: '订单管理', Icon: ShoppingCart },
  {
    label: '发票', Icon: Receipt,
    children: [
      { path: '/invoices', label: '开票管理', Icon: FileText },
      { path: '/companies', label: '公司信息', Icon: Building2 },
    ],
  },
  { path: '/settings', label: '系统设置', Icon: Settings },
];

type NavItem = typeof navItems[number];

interface OrderMessageRecord {
  salesperson?: string;
  paymentAccount?: string;
  paymentSplits?: Array<{ account?: string }> | string;
  orderType?: string;
  returnStatus?: string;
}

interface QueryOrdersResult {
  data?: OrderMessageRecord[];
  cursor?: string | null;
  hasMore?: boolean;
}

const ORDER_MESSAGE_PAGE_SIZE = 100;
const ORDER_MESSAGE_MAX_SCAN = 10000;

function getUserDisplayName(user: { id?: string; user_metadata?: { username?: string; nickName?: string } } | null) {
  return user?.user_metadata?.nickName || user?.user_metadata?.username || user?.id?.slice(0, 8) || '';
}

function hasUnreceivedPayment(order: OrderMessageRecord) {
  if (order.paymentAccount === '未收款') return true;
  const value = order.paymentSplits;
  const splits = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  return splits.some(split => split?.account === '未收款');
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status: permissionStatus, canInitialize, canAccessPage } = usePermission();
  const [collapsed, setCollapsed] = useState(false);
  const sidebarToggleLabel = collapsed ? '展开侧边栏' : '收起侧边栏';
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['发票']);
  const [currentUser, setCurrentUser] = useState<{ id?: string; user_metadata?: { username?: string; nickName?: string } } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [hasUserMessages, setHasUserMessages] = useState(false);
  const currentUserName = getUserDisplayName(currentUser);

  useEffect(() => {
    getCurrentUser().then(user => {
      if (user) setCurrentUser(user);
    });
  }, []);

  /** 获取待开票数量 */
  const fetchPendingCount = useCallback(async () => {
    try {
      const result = await callFunction<{ success?: boolean; total: number }>('countPendingInvoices');
      if (result.success) {
        setPendingCount(result.total);
      }
    } catch {
      // 静默失败，不影响主界面
    }
  }, []);

  useEffect(() => {
    fetchPendingCount();
    const timer = setInterval(fetchPendingCount, 60000);
    return () => clearInterval(timer);
  }, [fetchPendingCount]);

  /** 获取当前登录人的订单消息提示 */
  const fetchUserMessageStatus = useCallback(async () => {
    const username = getUserDisplayName(currentUser);
    if (!username) {
      setHasUserMessages(false);
      return;
    }

    try {
      let cursor: string | null = null;
      let hasMore = true;
      let scanned = 0;
      let nextHasMessages = false;

      while (hasMore && scanned < ORDER_MESSAGE_MAX_SCAN && !nextHasMessages) {
        const result: QueryOrdersResult = await callFunction<QueryOrdersResult>('queryOrders', {
          data: { limit: ORDER_MESSAGE_PAGE_SIZE, cursor },
        });
        const orders = result.data || [];
        scanned += orders.length;
        nextHasMessages = orders.some((order: OrderMessageRecord) => {
          if (order.salesperson !== username) return false;
          const needReturn = ['postRentalShip', 'postRentalReturn'].includes(order.orderType || '') && order.returnStatus !== 'returned';
          const needPayment = hasUnreceivedPayment(order);
          return needReturn || needPayment;
        });
        cursor = result.cursor || null;
        hasMore = !!result.hasMore && !!cursor && orders.length > 0;
      }

      setHasUserMessages(nextHasMessages);
    } catch {
      // 静默失败，不影响主界面
      setHasUserMessages(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchUserMessageStatus();
    const timer = setInterval(fetchUserMessageStatus, 60000);
    return () => clearInterval(timer);
  }, [fetchUserMessageStatus]);

  const toggleMenu = (label: string) => {
    setExpandedMenus(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    );
  };

  const isGroupActive = (children: { path: string }[]) =>
    children.some(c => location.pathname === c.path);

  const handleLogout = async () => {
    await signOut();
    MessagePlugin.success('已退出登录');
    navigate('/login', { replace: true });
  };

  const visibleNavItems = navItems
    .map((item): NavItem | null => {
      if (permissionStatus === 'loading') return null;

      if (permissionStatus === 'uninitialized') {
        return canInitialize && 'path' in item && item.path === '/settings' ? item : null;
      }

      if (permissionStatus !== 'ready') return null;

      if ('children' in item && item.children) {
        const children = item.children.filter(child => canAccessPage(child.path));
        if (children.length === 0) return null;
        return { ...item, children } as NavItem;
      }

      return 'path' in item && canAccessPage(item.path) ? item : null;
    })
    .filter((item): item is NavItem => !!item);

  return (
    <TLayout className="h-screen">
      {/* 侧边栏 */}
      <Aside
        className="!bg-sidebar !border-r-0"
        width={collapsed ? '64px' : '220px'}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center gap-3 px-4 h-16 border-b border-white/10">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center flex-shrink-0">
              <Package size={18} className="text-white" />
            </div>
            {!collapsed && (
              <span className="text-white font-semibold text-base whitespace-nowrap">
                租赁综合管理
              </span>
            )}
          </div>

          {/* 导航列表 */}
          <nav className="flex-1 pt-4 px-2 space-y-1">
            {visibleNavItems.map((item) => {
              // 带子菜单的分组
              if ('children' in item && item.children) {
                const groupActive = isGroupActive(item.children);
                const expanded = expandedMenus.includes(item.label);
                return (
                  <div key={item.label}>
                    <button
                      onClick={() => toggleMenu(item.label)}
                      className={`w-full relative flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer ${
                        groupActive
                          ? 'text-white bg-white/15'
                          : 'text-white/60 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      <item.Icon size={18} className="flex-shrink-0" />
                      {item.label === '发票' && pendingCount > 0 && (
                        <span className="absolute top-2 right-2 bg-red-500 rounded-full w-2 h-2" />
                      )}
                      {!collapsed && (
                        <>
                          <span className="text-sm whitespace-nowrap flex-1 text-left">{item.label}</span>
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </>
                      )}
                    </button>
                    {expanded && !collapsed && (
                      <div className="ml-5 mt-1 space-y-1">
                        {item.children.map((child) => {
                          const isActive = location.pathname === child.path;
                          return (
                            <button
                              key={child.path}
                              onClick={() => navigate(child.path)}
                              className={`w-full relative flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer ${
                                isActive
                                  ? 'text-white bg-white/15'
                                  : 'text-white/50 hover:text-white hover:bg-white/10'
                              }`}
                            >
                              <child.Icon size={16} className="flex-shrink-0" />
                              <span className="text-sm whitespace-nowrap flex-1 text-left">{child.label}</span>
                              {child.path === '/invoices' && pendingCount > 0 && (
                                <span className="bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-5 flex items-center justify-center px-1.5 leading-none">
                                  {pendingCount > 99 ? '99+' : pendingCount}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // 普通菜单项
              const { path, label, Icon } = item as { path: string; label: string; Icon: React.ComponentType<{ size?: number; className?: string }> };
              const isActive = location.pathname === path;
              return (
                <button
                  key={path}
                  onClick={() => navigate(path)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer ${
                    isActive
                      ? 'text-white bg-white/15'
                      : 'text-white/60 hover:text-white hover:bg-white/10'
                  }`}
                >
                  <Icon size={18} className="flex-shrink-0" />
                  {!collapsed && <span className="text-sm whitespace-nowrap">{label}</span>}
                </button>
              );
            })}
          </nav>
        </div>
      </Aside>

      <TLayout>
        {/* 顶栏 */}
        <Header className="!bg-white/95 border-b border-gray-100 !h-14 flex items-center justify-between px-6">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-gray-500 hover:text-primary"
            title={sidebarToggleLabel}
            aria-label={sidebarToggleLabel}
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>

          {/* 用户信息 + 退出 */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="relative flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-primary"
              title="消息提醒"
              aria-label="消息提醒"
            >
              <Bell size={17} />
              {hasUserMessages && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
              )}
            </button>
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <User size={16} className="text-gray-400" />
              <span className="text-gray-500">用户名:</span>
              <span className="font-medium text-gray-800">
                {currentUserName || '--'}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-500 hover:text-danger hover:bg-red-50 rounded-lg cursor-pointer"
            >
              <LogOut size={16} />
              <span>退出</span>
            </button>
          </div>
        </Header>

        {/* 内容区 */}
        <Content className="!bg-gray-50 overflow-auto">
          <div className="flex min-h-full flex-col p-6">
            <div className="flex-1">
              {children}
            </div>
            <footer className="mt-8 py-4 text-center text-sm text-gray-400">
              Copyright 2026 Yuntu. All Rights Reserved
            </footer>
          </div>
        </Content>
      </TLayout>
    </TLayout>
  );
}
