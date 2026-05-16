import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { InboundList } from './pages/InboundList';
import { OutboundList } from './pages/OutboundList';
import { Stats } from './pages/Stats';
import { Logs } from './pages/Logs';
import { PhoneModels } from './pages/PhoneModels';
import { Inventory } from './pages/Inventory';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout><Dashboard /></AppLayout>} />
        <Route path="/inbound" element={<AppLayout><InboundList /></AppLayout>} />
        <Route path="/outbound" element={<AppLayout><OutboundList /></AppLayout>} />
        <Route path="/inventory" element={<AppLayout><Inventory /></AppLayout>} />
        <Route path="/stats" element={<AppLayout><Stats /></AppLayout>} />
        <Route path="/logs" element={<AppLayout><Logs /></AppLayout>} />
        <Route path="/models" element={<AppLayout><PhoneModels /></AppLayout>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
