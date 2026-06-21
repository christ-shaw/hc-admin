import { Suspense, lazy, ComponentType } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { AppLayout } from './components/Layout';
import { PermissionGuard } from './components/PermissionGuard';
import { PermissionProvider } from './contexts/PermissionContext';
import { Login } from './pages/Login';

/** 为命名导出的组件创建 lazy wrapper */
function lazyNamed<T extends Record<string, ComponentType<unknown>>>(
  importer: () => Promise<T>,
  name: keyof T
) {
  return lazy(() => importer().then(m => ({ default: m[name] })));
}

const Dashboard = lazyNamed(() => import('./pages/Dashboard'), 'Dashboard');
const InboundList = lazyNamed(() => import('./pages/InboundList'), 'InboundList');
const OutboundList = lazyNamed(() => import('./pages/OutboundList'), 'OutboundList');
const Stats = lazyNamed(() => import('./pages/Stats'), 'Stats');
const Logs = lazyNamed(() => import('./pages/Logs'), 'Logs');
const PhoneModels = lazyNamed(() => import('./pages/PhoneModels'), 'PhoneModels');
const Inventory = lazyNamed(() => import('./pages/Inventory'), 'Inventory');
const Orders = lazyNamed(() => import('./pages/Orders'), 'Orders');
const Invoices = lazyNamed(() => import('./pages/Invoices'), 'Invoices');
const Companies = lazyNamed(() => import('./pages/Companies'), 'Companies');
const SettingsPage = lazyNamed(() => import('./pages/Settings'), 'SettingsPage');
const NotFound = lazyNamed(() => import('./pages/NotFound'), 'NotFound');
const Forbidden = lazyNamed(() => import('./pages/Forbidden'), 'Forbidden');

/** 路由懒加载时的 loading 占位 */
function PageLoader() {
  return <div className="flex items-center justify-center h-64"><div className="rounded-full h-8 w-8 border-2 border-blue-500 border-b-transparent" /></div>;
}

export default function App() {
  return (
    <HashRouter>
      <PermissionProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* 所有需要登录的页面包裹在 AuthGuard 中 */}
          <Route element={<AuthGuard />}>
            <Route element={<PermissionGuard />}>
              <Route path="/forbidden" element={<AppLayout><Suspense fallback={<PageLoader />}><Forbidden /></Suspense></AppLayout>} />
              <Route path="/" element={<AppLayout><Suspense fallback={<PageLoader />}><Dashboard /></Suspense></AppLayout>} />
              <Route path="/inbound" element={<AppLayout><Suspense fallback={<PageLoader />}><InboundList /></Suspense></AppLayout>} />
              <Route path="/outbound" element={<AppLayout><Suspense fallback={<PageLoader />}><OutboundList /></Suspense></AppLayout>} />
              <Route path="/inventory" element={<AppLayout><Suspense fallback={<PageLoader />}><Inventory /></Suspense></AppLayout>} />
              <Route path="/stats" element={<AppLayout><Suspense fallback={<PageLoader />}><Stats /></Suspense></AppLayout>} />
              <Route path="/logs" element={<AppLayout><Suspense fallback={<PageLoader />}><Logs /></Suspense></AppLayout>} />
              <Route path="/models" element={<AppLayout><Suspense fallback={<PageLoader />}><PhoneModels /></Suspense></AppLayout>} />
              <Route path="/orders" element={<AppLayout><Suspense fallback={<PageLoader />}><Orders /></Suspense></AppLayout>} />
              <Route path="/invoices" element={<AppLayout><Suspense fallback={<PageLoader />}><Invoices /></Suspense></AppLayout>} />
              <Route path="/companies" element={<AppLayout><Suspense fallback={<PageLoader />}><Companies /></Suspense></AppLayout>} />
              <Route path="/settings" element={<AppLayout><Suspense fallback={<PageLoader />}><SettingsPage /></Suspense></AppLayout>} />
            </Route>
            <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFound /></Suspense>} />
          </Route>
        </Routes>
      </PermissionProvider>
    </HashRouter>
  );
}
