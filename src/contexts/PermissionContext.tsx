import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  callFunction,
  getCurrentPermissionUserPayload,
  onAuthStateChanged,
  offAuthStateChanged,
} from '../lib/cloudbase';

export type PermissionStatus =
  | 'loading'
  | 'ready'
  | 'uninitialized'
  | 'unassigned'
  | 'forbidden'
  | 'error';

interface RolePermissionData {
  roleId: string;
  roleName: string;
  roleCode?: string;
  pagePermissions?: string[];
  actionPermissions?: string[];
}

interface GetUserRoleResult {
  success?: boolean;
  initialized?: boolean;
  status?: PermissionStatus;
  data?: RolePermissionData | null;
  canInitialize?: boolean;
  code?: string;
  errMsg?: string;
}

interface PermissionContextType {
  status: PermissionStatus;
  initialized: boolean;
  canInitialize: boolean;
  roleId: string | null;
  roleName: string | null;
  roleCode: string | null;
  pagePermissions: string[];
  actionPermissions: string[];
  errorMessage: string;
  canAccessPage: (path: string) => boolean;
  can: (permission: string) => boolean;
  refreshPermissions: () => Promise<void>;
}

const PermissionContext = createContext<PermissionContextType | null>(null);

function normalizePath(path: string) {
  if (!path || path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function unique(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function getStatusMessage(status: PermissionStatus, fallback?: string) {
  if (fallback) return fallback;
  if (status === 'uninitialized') return '权限系统尚未初始化';
  if (status === 'unassigned') return '当前用户未分配角色，请联系管理员';
  if (status === 'forbidden') return '当前用户无权访问系统';
  if (status === 'error') return '权限加载失败，请稍后重试';
  return '';
}

export function PermissionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<PermissionStatus>('loading');
  const [initialized, setInitialized] = useState(false);
  const [canInitialize, setCanInitialize] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roleName, setRoleName] = useState<string | null>(null);
  const [roleCode, setRoleCode] = useState<string | null>(null);
  const [pagePermissions, setPagePermissions] = useState<string[]>([]);
  const [actionPermissions, setActionPermissions] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  const clearPermissions = useCallback(() => {
    setInitialized(false);
    setCanInitialize(false);
    setRoleId(null);
    setRoleName(null);
    setRoleCode(null);
    setPagePermissions([]);
    setActionPermissions([]);
  }, []);

  const refreshPermissions = useCallback(async () => {
    setStatus('loading');
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      if (!currentUser) {
        clearPermissions();
        setErrorMessage('请先登录');
        setStatus('forbidden');
        return;
      }
      const result = await callFunction<GetUserRoleResult>('getUserRole', { currentUser });
      const nextStatus = result.status || (result.success ? 'ready' : 'error');
      const data = result.data || null;

      setInitialized(!!result.initialized);
      setCanInitialize(!!result.canInitialize);
      setRoleId(data?.roleId || null);
      setRoleName(data?.roleName || null);
      setRoleCode(data?.roleCode || null);
      setPagePermissions(unique(data?.pagePermissions));
      setActionPermissions(unique(data?.actionPermissions));
      setErrorMessage(getStatusMessage(nextStatus, result.errMsg));
      setStatus(nextStatus);
    } catch (error) {
      clearPermissions();
      setErrorMessage(error instanceof Error ? error.message : '权限加载失败，请稍后重试');
      setStatus('error');
    }
  }, [clearPermissions]);

  useEffect(() => {
    refreshPermissions();
  }, [refreshPermissions]);

  useEffect(() => {
    const handleAuthStateChanged = () => {
      refreshPermissions();
    };
    onAuthStateChanged(handleAuthStateChanged);
    return () => offAuthStateChanged(handleAuthStateChanged);
  }, [refreshPermissions]);

  const canAccessPage = useCallback((path: string) => {
    const normalizedPath = normalizePath(path);
    return pagePermissions.includes(normalizedPath);
  }, [pagePermissions]);

  const can = useCallback((permission: string) => {
    return actionPermissions.includes('*') || actionPermissions.includes(permission);
  }, [actionPermissions]);

  const value = useMemo<PermissionContextType>(() => ({
    status,
    initialized,
    canInitialize,
    roleId,
    roleName,
    roleCode,
    pagePermissions,
    actionPermissions,
    errorMessage,
    canAccessPage,
    can,
    refreshPermissions,
  }), [
    status,
    initialized,
    canInitialize,
    roleId,
    roleName,
    roleCode,
    pagePermissions,
    actionPermissions,
    errorMessage,
    canAccessPage,
    can,
    refreshPermissions,
  ]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermission() {
  const context = useContext(PermissionContext);
  if (!context) {
    throw new Error('usePermission must be used within PermissionProvider');
  }
  return context;
}
