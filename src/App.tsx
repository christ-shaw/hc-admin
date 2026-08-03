import { Suspense, lazy, ComponentType } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { PermissionGuard } from './components/PermissionGuard';
import { PermissionProvider } from './contexts/PermissionContext';
import { DictionaryProvider } from './contexts/DictionaryContext';
import { TabWorkspace } from './contexts/TabWorkspaceContext';
import { appRoutes } from './routes/appRoutes';
import { Login } from './pages/Login';

/** 为命名导出的组件创建 lazy wrapper */
function lazyNamed<T extends Record<string, ComponentType<unknown>>>(
  importer: () => Promise<T>,
  name: keyof T
) {
  return lazy(() => importer().then(m => ({ default: m[name] })));
}

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
        <DictionaryProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<AuthGuard />}>
              <Route path="/forbidden" element={<Suspense fallback={<PageLoader />}><Forbidden /></Suspense>} />
              <Route element={<PermissionGuard />}>
                <Route element={<Suspense fallback={<PageLoader />}><TabWorkspace /></Suspense>}>
                  {appRoutes.map(route => <Route key={route.path} path={route.path} element={null} />)}
                </Route>
              </Route>
              <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFound /></Suspense>} />
            </Route>
          </Routes>
        </DictionaryProvider>
      </PermissionProvider>
    </HashRouter>
  );
}
