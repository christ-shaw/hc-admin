import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { AppLayout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { InboundList } from './pages/InboundList';
import { OutboundList } from './pages/OutboundList';
import { Stats } from './pages/Stats';
import { Logs } from './pages/Logs';
import { PhoneModels } from './pages/PhoneModels';
import { Inventory } from './pages/Inventory';
import { Orders } from './pages/Orders';
import { Invoices } from './pages/Invoices';
import { Companies } from './pages/Companies';
import { SettingsPage } from './pages/Settings';
import { NotFound } from './pages/NotFound';

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* 所有需要登录的页面包裹在 AuthGuard 中 */}
        <Route element={<AuthGuard />}>
          <Route path="/" element={<AppLayout><Dashboard /></AppLayout>} />
          <Route path="/inbound" element={<AppLayout><InboundList /></AppLayout>} />
          <Route path="/outbound" element={<AppLayout><OutboundList /></AppLayout>} />
          <Route path="/inventory" element={<AppLayout><Inventory /></AppLayout>} />
          <Route path="/stats" element={<AppLayout><Stats /></AppLayout>} />
          <Route path="/logs" element={<AppLayout><Logs /></AppLayout>} />
          <Route path="/models" element={<AppLayout><PhoneModels /></AppLayout>} />
          <Route path="/orders" element={<AppLayout><Orders /></AppLayout>} />
          <Route path="/invoices" element={<AppLayout><Invoices /></AppLayout>} />
          <Route path="/companies" element={<AppLayout><Companies /></AppLayout>} />
          <Route path="/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
