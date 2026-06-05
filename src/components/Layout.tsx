import { useState, useEffect } from 'react';
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
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getCurrentUser, signOut } from '../lib/cloudbase';

const { Header, Content, Aside } = TLayout;

const navItems = [
  { path: '/', label: '仪表盘', Icon: LayoutDashboard },
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
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['发票']);
  const [currentUser, setCurrentUser] = useState<{ id?: string; user_metadata?: { username?: string; nickName?: string } } | null>(null);

  useEffect(() => {
    getCurrentUser().then(user => {
      if (user) setCurrentUser(user);
    });
  }, []);

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

  return (
    <TLayout className="h-screen">
      {/* 侧边栏 */}
      <Aside
        className="!bg-gradient-to-b from-sidebar to-[#0f1923] !border-r-0 transition-all duration-300"
        width={collapsed ? '64px' : '220px'}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center gap-3 px-4 h-16 border-b border-white/10">
            <div className="w-8 h-8 bg-gradient-to-br from-primary to-primary-light rounded-lg flex items-center justify-center flex-shrink-0">
              <Package size={18} className="text-white" />
            </div>
            {!collapsed && (
              <span className="text-white font-semibold text-base whitespace-nowrap">
                出入库管理
              </span>
            )}
          </div>

          {/* 导航列表 */}
          <nav className="flex-1 pt-4 px-2 space-y-1">
            {navItems.map((item) => {
              // 带子菜单的分组
              if ('children' in item && item.children) {
                const groupActive = isGroupActive(item.children);
                const expanded = expandedMenus.includes(item.label);
                return (
                  <div key={item.label}>
                    <button
                      onClick={() => toggleMenu(item.label)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 cursor-pointer ${
                        groupActive
                          ? 'text-white bg-white/15 shadow-[0_0_20px_rgba(0,82,217,0.3)]'
                          : 'text-white/60 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      <item.Icon size={18} className="flex-shrink-0" />
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
                              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 cursor-pointer ${
                                isActive
                                  ? 'text-white bg-white/15'
                                  : 'text-white/50 hover:text-white hover:bg-white/10'
                              }`}
                            >
                              <child.Icon size={16} className="flex-shrink-0" />
                              <span className="text-sm whitespace-nowrap">{child.label}</span>
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
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 cursor-pointer ${
                    isActive
                      ? 'text-white bg-white/15 shadow-[0_0_20px_rgba(0,82,217,0.3)]'
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
        <Header className="!bg-white/80 !backdrop-blur-xl border-b border-gray-100 !h-14 flex items-center justify-between px-6">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-gray-500 hover:text-primary transition-colors"
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>

          {/* 用户信息 + 退出 */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <User size={16} className="text-gray-400" />
              <span className="text-gray-500">用户名:</span>
              <span className="font-medium text-gray-800">
                {currentUser?.user_metadata?.nickName || currentUser?.user_metadata?.username || currentUser?.id?.slice(0, 8) || '--'}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-500 hover:text-danger hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
            >
              <LogOut size={16} />
              <span>退出</span>
            </button>
          </div>
        </Header>

        {/* 内容区 */}
        <Content className="!bg-gray-50 !p-6 overflow-auto">
          {children}
        </Content>
      </TLayout>
    </TLayout>
  );
}
