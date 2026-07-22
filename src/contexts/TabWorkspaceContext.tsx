import {
  Component,
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, ConfigProvider, Loading } from 'tdesign-react';
import { X } from 'lucide-react';
import { AppLayout } from '../components/Layout';
import { usePermission } from './PermissionContext';
import { getCurrentUser } from '../lib/cloudbase';
import { appRoutes, getAppRoute, type AppRouteMeta } from '../routes/appRoutes';

export interface WorkspaceTab {
  path: string;
  title: string;
  closable: boolean;
}

interface DirtyTabState {
  dirty: boolean;
  message?: string;
}

interface PersistedWorkspace {
  paths: string[];
  activePath: string;
}

export interface TabWorkspaceContextType {
  tabs: WorkspaceTab[];
  activePath: string;
  openTab: (path: string, options?: { state?: unknown; replace?: boolean }) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeRightTabs: (path: string) => void;
  closeAllTabs: () => void;
  setTabDirty: (path: string, dirty: boolean, message?: string) => void;
  isTabDirty: (path: string) => boolean;
}

const TabWorkspaceContext = createContext<TabWorkspaceContextType | null>(null);
const TabPanelPathContext = createContext('');
const STORAGE_PREFIX = 'hc_admin_workspace_tabs_v1:';

function toTab(route: AppRouteMeta): WorkspaceTab {
  return { path: route.path, title: route.label, closable: route.closable };
}

function readPersisted(userId: string): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    return raw ? JSON.parse(raw) as PersistedWorkspace : null;
  } catch {
    return null;
  }
}

function LoadingWorkspace() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Loading loading text="正在恢复工作区..." />
    </div>
  );
}

interface WorkspacePageErrorBoundaryProps {
  title: string;
  children: ReactNode;
}

interface WorkspacePageErrorBoundaryState {
  error: Error | null;
}

class WorkspacePageErrorBoundary extends Component<WorkspacePageErrorBoundaryProps, WorkspacePageErrorBoundaryState> {
  state: WorkspacePageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WorkspacePageErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`标签页「${this.props.title}」渲染失败`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="glass-card mx-auto mt-12 max-w-xl p-8 text-center">
        <h2 className="text-lg font-semibold text-gray-800">{this.props.title}加载失败</h2>
        <p className="mt-2 text-sm text-gray-500">该页面发生异常，其他标签页仍可继续使用。</p>
        <Button className="mt-5" theme="primary" onClick={() => this.setState({ error: null })}>重试页面</Button>
      </div>
    );
  }
}

export function TabWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, canInitialize, canAccessPage } = usePermission();
  const [userId, setUserId] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activePath, setActivePath] = useState('');
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, DirtyTabState>>({});
  const [pendingClose, setPendingClose] = useState<string[]>([]);
  const dirtyTabsRef = useRef(dirtyTabs);

  useEffect(() => {
    dirtyTabsRef.current = dirtyTabs;
  }, [dirtyTabs]);

  const isAllowed = useCallback((path: string) => {
    if (!getAppRoute(path)) return false;
    if (status === 'uninitialized') return canInitialize && path === '/settings';
    return status === 'ready' && canAccessPage(path);
  }, [canAccessPage, canInitialize, status]);

  const fallbackPath = useMemo(() => {
    if (status === 'uninitialized' && canInitialize) return '/settings';
    if (status !== 'ready') return '';
    if (canAccessPage('/')) return '/';
    return appRoutes.find(route => canAccessPage(route.path))?.path || '';
  }, [canAccessPage, canInitialize, status]);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser().then(user => {
      if (cancelled) return;
      setUserId(user?.id || 'unknown');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!userId || !fallbackPath || hydrated) return;
    const persisted = readPersisted(userId);
    const restoredPaths = (persisted?.paths || []).filter(isAllowed);
    const seedPaths = fallbackPath === '/' ? ['/', ...restoredPaths.filter(path => path !== '/')] : restoredPaths;
    const currentPath = isAllowed(location.pathname) ? location.pathname : '';
    const paths = Array.from(new Set([...(seedPaths.length ? seedPaths : [fallbackPath]), ...(currentPath ? [currentPath] : [])]));
    const restoredActive = persisted?.activePath && paths.includes(persisted.activePath) ? persisted.activePath : '';
    const restoreRequested = !!(location.state as { restoreWorkspace?: boolean } | null)?.restoreWorkspace;
    const nextActive = (restoreRequested ? restoredActive : currentPath) || restoredActive || fallbackPath;
    setTabs(paths.map(path => toTab(getAppRoute(path)!)));
    setActivePath(nextActive);
    setHydrated(true);
    if (location.pathname !== nextActive || restoreRequested) navigate(nextActive, { replace: true });
  }, [fallbackPath, hydrated, isAllowed, location.pathname, location.state, navigate, userId]);

  useEffect(() => {
    if (!hydrated) return;
    const allowedTabs = tabs.filter(tab => isAllowed(tab.path));
    const nextTabs = fallbackPath === '/' && !allowedTabs.some(tab => tab.path === '/')
      ? [toTab(getAppRoute('/')!), ...allowedTabs]
      : allowedTabs;
    if (nextTabs.length !== tabs.length || nextTabs.some((tab, index) => tab.path !== tabs[index]?.path)) {
      setTabs(nextTabs);
    }
    if (activePath && !nextTabs.some(tab => tab.path === activePath) && fallbackPath) {
      setActivePath(fallbackPath);
      navigate(fallbackPath, { replace: true });
    }
  }, [activePath, fallbackPath, hydrated, isAllowed, navigate, tabs]);

  useEffect(() => {
    if (!hydrated || !isAllowed(location.pathname)) return;
    const route = getAppRoute(location.pathname)!;
    setTabs(current => current.some(tab => tab.path === route.path) ? current : [...current, toTab(route)]);
    setActivePath(route.path);
  }, [hydrated, isAllowed, location.pathname, location.key]);

  useEffect(() => {
    if (!hydrated || !userId || !activePath) return;
    const value: PersistedWorkspace = { paths: tabs.map(tab => tab.path), activePath };
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(value));
  }, [activePath, hydrated, tabs, userId]);

  const openTab = useCallback((path: string, options?: { state?: unknown; replace?: boolean }) => {
    if (!isAllowed(path)) return;
    navigate(path, { state: options?.state, replace: options?.replace });
  }, [isAllowed, navigate]);

  const performClose = useCallback((paths: string[]) => {
    const closing = new Set(paths.filter(path => getAppRoute(path)?.closable));
    if (!closing.size) return;
    const currentTabs = tabs;
    const activeIndex = currentTabs.findIndex(tab => tab.path === activePath);
    const remaining = currentTabs.filter(tab => !closing.has(tab.path));
    setTabs(remaining);
    setDirtyTabs(current => {
      const next = { ...current };
      closing.forEach(path => delete next[path]);
      return next;
    });
    if (closing.has(activePath)) {
      const right = currentTabs.find((tab, index) => index > activeIndex && !closing.has(tab.path));
      const left = [...currentTabs].reverse().find((tab, reverseIndex) => {
        const index = currentTabs.length - 1 - reverseIndex;
        return index < activeIndex && !closing.has(tab.path);
      });
      const nextPath = right?.path || left?.path || fallbackPath;
      if (nextPath) {
        // 先同步工作区激活状态，避免权限裁剪 effect 将刚关闭的标签误判为越权并跳回首页。
        setActivePath(nextPath);
        navigate(nextPath, { replace: true });
      }
    }
  }, [activePath, fallbackPath, navigate, tabs]);

  const requestClose = useCallback((paths: string[]) => {
    const closablePaths = paths.filter(path => getAppRoute(path)?.closable);
    if (!closablePaths.length) return;
    if (closablePaths.some(path => dirtyTabsRef.current[path]?.dirty)) {
      setPendingClose(closablePaths);
      return;
    }
    performClose(closablePaths);
  }, [performClose]);

  const closeTab = useCallback((path: string) => requestClose([path]), [requestClose]);
  const closeOtherTabs = useCallback((path: string) => {
    requestClose(tabs.filter(tab => tab.path !== path && tab.closable).map(tab => tab.path));
  }, [requestClose, tabs]);
  const closeRightTabs = useCallback((path: string) => {
    const index = tabs.findIndex(tab => tab.path === path);
    requestClose(tabs.slice(index + 1).filter(tab => tab.closable).map(tab => tab.path));
  }, [requestClose, tabs]);
  const closeAllTabs = useCallback(() => {
    requestClose(tabs.filter(tab => tab.closable).map(tab => tab.path));
  }, [requestClose, tabs]);

  const setTabDirty = useCallback((path: string, dirty: boolean, message?: string) => {
    if (!path) return;
    setDirtyTabs(current => {
      if (!dirty) {
        if (!current[path]) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      if (current[path]?.dirty && current[path]?.message === message) return current;
      return { ...current, [path]: { dirty: true, message } };
    });
  }, []);

  const value = useMemo<TabWorkspaceContextType>(() => ({
    tabs,
    activePath,
    openTab,
    closeTab,
    closeOtherTabs,
    closeRightTabs,
    closeAllTabs,
    setTabDirty,
    isTabDirty: path => !!dirtyTabs[path]?.dirty,
  }), [activePath, closeAllTabs, closeOtherTabs, closeRightTabs, closeTab, dirtyTabs, openTab, setTabDirty, tabs]);

  if (!hydrated) return <LoadingWorkspace />;

  const dirtyClosingTabs = pendingClose
    .filter(path => dirtyTabs[path]?.dirty)
    .map(path => dirtyTabs[path]?.message || getAppRoute(path)?.label || path);

  return (
    <TabWorkspaceContext.Provider value={value}>
      <AppLayout>
        <div className="relative h-full min-h-0">
          {tabs.map(tab => {
            const route = getAppRoute(tab.path)!;
            const Page = route.Component;
            const active = tab.path === activePath;
            const portalId = `workspace-portal-${tab.path === '/' ? 'home' : tab.path.slice(1).replace(/[^a-z0-9-]/gi, '-')}`;
            return (
              <TabPanelPathContext.Provider key={tab.path} value={tab.path}>
                <section
                  className={`h-full overflow-y-auto overflow-x-hidden ${active ? 'block' : 'hidden'}`}
                  aria-hidden={!active}
                >
                  <div id={portalId} />
                  <div className="flex min-h-full min-w-0 flex-col p-6">
                    <div className="min-w-0 flex-1">
                      <ConfigProvider globalConfig={{ attach: `#${portalId}` }} notSet>
                        <WorkspacePageErrorBoundary title={tab.title}>
                          <Suspense fallback={<div className="flex h-64 items-center justify-center"><Loading loading text="加载页面..." /></div>}>
                            <Page />
                          </Suspense>
                        </WorkspacePageErrorBoundary>
                      </ConfigProvider>
                    </div>
                    <footer className="mt-8 py-4 text-center text-sm text-gray-400">
                      Copyright 2026 Hongcheng. All Rights Reserved
                    </footer>
                  </div>
                </section>
              </TabPanelPathContext.Provider>
            );
          })}
        </div>
      </AppLayout>

      {pendingClose.length > 0 && (
        <div className="fixed inset-0 z-[7000] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="workspace-dirty-dialog-title">
          <div className="w-full max-w-[480px] rounded-xl bg-white p-6 shadow-2xl">
            <h2 id="workspace-dirty-dialog-title" className="text-lg font-semibold text-gray-800">存在未保存的修改</h2>
            <div className="mt-4 space-y-3 text-sm text-gray-600">
              <p>以下页面包含尚未保存的内容，关闭后这些修改将丢失：</p>
              <ul className="space-y-1">
                {dirtyClosingTabs.map((title, index) => (
                  <li key={`${title}-${index}`} className="flex items-center gap-2">
                    <X size={14} className="text-red-500" />{title}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingClose([])}>取消</Button>
              <Button theme="danger" onClick={() => {
                const paths = pendingClose;
                setPendingClose([]);
                performClose(paths);
              }}>放弃修改并关闭</Button>
            </div>
          </div>
        </div>
      )}
    </TabWorkspaceContext.Provider>
  );
}

export function useTabWorkspace() {
  const context = useContext(TabWorkspaceContext);
  if (!context) throw new Error('useTabWorkspace must be used within TabWorkspace');
  return context;
}

export function useTabDirty(dirty: boolean, message?: string) {
  const path = useContext(TabPanelPathContext);
  const context = useContext(TabWorkspaceContext);
  const setTabDirty = context?.setTabDirty;
  useEffect(() => {
    if (!setTabDirty || !path) return;
    setTabDirty(path, dirty, message);
    return () => setTabDirty(path, false);
  }, [dirty, message, path, setTabDirty]);
}
