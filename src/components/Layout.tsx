import { useState } from 'react';
import { Layout as TLayout } from 'tdesign-react';
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
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';

const { Header, Content, Aside } = TLayout;

const navItems = [
  { path: '/', label: '仪表盘', Icon: LayoutDashboard },
  { path: '/inbound', label: '入库记录', Icon: ArrowDownCircle },
  { path: '/outbound', label: '出库记录', Icon: ArrowUpCircle },
  { path: '/inventory', label: '库存管理', Icon: Warehouse },
  { path: '/stats', label: '统计分析', Icon: BarChart3 },
  { path: '/logs', label: '操作日志', Icon: FileText },
  { path: '/models', label: '型号管理', Icon: Smartphone },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

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
            {navItems.map(({ path, label, Icon }) => {
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
        <Header className="!bg-white/80 !backdrop-blur-xl border-b border-gray-100 !h-14 flex items-center px-6">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-gray-500 hover:text-primary transition-colors"
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
        </Header>

        {/* 内容区 */}
        <Content className="!bg-gray-50 !p-6 overflow-auto">
          {children}
        </Content>
      </TLayout>
    </TLayout>
  );
}
