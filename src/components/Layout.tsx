import { useState, useEffect, useCallback } from 'react';
import { Layout as TLayout, MessagePlugin } from 'tdesign-react';
import {
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  User,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getCurrentUser, signOut, callFunction } from '../lib/cloudbase';
import { usePermission } from '../contexts/PermissionContext';
import { appNavigation, isAppNavGroup, type AppNavItem } from '../routes/appRoutes';
import { useTabWorkspace } from '../contexts/TabWorkspaceContext';

const { Header, Content, Aside } = TLayout;

function getUserDisplayName(user: { id?: string; user_metadata?: { username?: string; nickName?: string } } | null) {
  return user?.user_metadata?.nickName || user?.user_metadata?.username || user?.id?.slice(0, 8) || '';
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const {
    tabs,
    activePath,
    openTab,
    closeTab,
    closeOtherTabs,
    closeRightTabs,
    closeAllTabs,
    isTabDirty,
  } = useTabWorkspace();
  const { status: permissionStatus, canInitialize, canAccessPage } = usePermission();
  const [collapsed, setCollapsed] = useState(false);
  const sidebarToggleLabel = collapsed ? '展开侧边栏' : '收起侧边栏';
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['发票']);
  const [currentUser, setCurrentUser] = useState<{ id?: string; user_metadata?: { username?: string; nickName?: string } } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [tabMenu, setTabMenu] = useState<{ path: string; x: number; y: number } | null>(null);
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

  const toggleMenu = (label: string) => {
    setExpandedMenus(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    );
  };

  const isGroupActive = (children: { path: string }[]) =>
    children.some(c => activePath === c.path);

  const handleLogout = async () => {
    await signOut();
    MessagePlugin.success('已退出登录');
    navigate('/login', { replace: true });
  };

  const visibleNavItems = appNavigation
    .map((item): AppNavItem | null => {
      if (permissionStatus === 'loading') return null;

      if (permissionStatus === 'uninitialized') {
        return canInitialize && !isAppNavGroup(item) && item.path === '/settings' ? item : null;
      }

      if (permissionStatus !== 'ready') return null;

      if (isAppNavGroup(item)) {
        const children = item.children.filter(child => canAccessPage(child.path));
        if (children.length === 0) return null;
        return { ...item, children };
      }

      return canAccessPage(item.path) ? item : null;
    })
    .filter((item): item is AppNavItem => !!item);

  useEffect(() => {
    if (!tabMenu) return;
    const closeMenu = () => setTabMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [tabMenu]);

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
              if (isAppNavGroup(item)) {
                const groupActive = isGroupActive(item.children);
                const expanded = expandedMenus.includes(item.label);
                return (
                  <div key={item.label}>
                    <button
                      onClick={() => toggleMenu(item.label)}
                      aria-label={item.label}
                      title={collapsed ? item.label : undefined}
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
                          const isActive = activePath === child.path;
                          return (
                            <button
                              key={child.path}
                              onClick={() => openTab(child.path)}
                              aria-label={child.label}
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
              const { path, label, Icon } = item;
              const isActive = activePath === path;
              return (
                <button
                  key={path}
                  onClick={() => openTab(path)}
                  aria-label={label}
                  title={collapsed ? label : undefined}
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

      <TLayout className="min-h-0 min-w-0">
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

        <div className="relative z-[3000] flex h-11 min-w-0 items-end border-b border-gray-200 bg-white px-2">
          <div className="workspace-tabs-scroll flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1">
            {tabs.map(tab => (
              <button
                key={tab.path}
                type="button"
                onClick={() => openTab(tab.path)}
                onContextMenu={event => {
                  event.preventDefault();
                  setTabMenu({ path: tab.path, x: event.clientX, y: event.clientY });
                }}
                className={`group flex h-9 flex-shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
                  activePath === tab.path
                    ? 'bg-blue-50 font-medium text-primary'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isTabDirty(tab.path) ? 'bg-orange-500' : 'bg-transparent'}`} />
                <span>{tab.title}</span>
                {tab.closable && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`关闭${tab.title}`}
                    onClick={event => { event.stopPropagation(); closeTab(tab.path); }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(tab.path);
                      }
                    }}
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  >
                    <X size={13} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {tabMenu && (
          <div
            className="fixed z-[6000] min-w-[132px] rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-xl"
            style={{ left: Math.min(tabMenu.x, window.innerWidth - 150), top: Math.min(tabMenu.y, window.innerHeight - 170) }}
            onClick={event => event.stopPropagation()}
          >
            <button className="w-full px-4 py-2 text-left hover:bg-gray-50 disabled:text-gray-300" disabled={!tabs.find(tab => tab.path === tabMenu.path)?.closable} onClick={() => { closeTab(tabMenu.path); setTabMenu(null); }}>关闭</button>
            <button className="w-full px-4 py-2 text-left hover:bg-gray-50" onClick={() => { closeOtherTabs(tabMenu.path); setTabMenu(null); }}>关闭其他</button>
            <button className="w-full px-4 py-2 text-left hover:bg-gray-50" onClick={() => { closeRightTabs(tabMenu.path); setTabMenu(null); }}>关闭右侧</button>
            <button className="w-full px-4 py-2 text-left hover:bg-gray-50" onClick={() => { closeAllTabs(); setTabMenu(null); }}>关闭全部</button>
          </div>
        )}

        {/* 各标签页拥有独立滚动容器，切换时保持滚动位置 */}
        <Content className="!bg-gray-50 min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}
        </Content>
      </TLayout>
    </TLayout>
  );
}
