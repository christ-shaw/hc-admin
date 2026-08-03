import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loading } from 'tdesign-react';
import { usePermission } from '../contexts/PermissionContext';
import { appRoutes } from '../routes/appRoutes';

function PageLoader() {
  return (
    <div className="min-h-[320px] flex items-center justify-center">
      <Loading loading text="加载权限..." />
    </div>
  );
}

export function PermissionGuard() {
  const { status, canInitialize, canAccessPage } = usePermission();
  const location = useLocation();
  const path = location.pathname;

  if (status === 'loading') return <PageLoader />;

  if (status === 'uninitialized') {
    if (canInitialize && path === '/settings') return <Outlet />;
    return canInitialize
      ? <Navigate to="/settings" replace />
      : (path === '/forbidden' ? <Outlet /> : <Navigate to="/forbidden" replace />);
  }

  if (status !== 'ready') {
    return path === '/forbidden' ? <Outlet /> : <Navigate to="/forbidden" replace />;
  }

  if (path === '/forbidden') {
    const fallbackPath = canAccessPage('/')
      ? '/'
      : appRoutes.find(route => canAccessPage(route.path))?.path;
    return fallbackPath ? <Navigate to={fallbackPath} replace /> : <Outlet />;
  }

  if (!canAccessPage(path)) {
    return <Navigate to="/forbidden" replace />;
  }

  return <Outlet />;
}
