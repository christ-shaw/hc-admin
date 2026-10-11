import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'tdesign-react/dist/tdesign.min.css';
import '../../src/styles/index.css';
import InvoiceOrderFields from '../../src/components/InvoiceOrderFields';
import type { InvoiceDraft } from '../../src/utils/invoiceOrders';
function App() {
  const [form, setForm] = useState<InvoiceDraft>({ companyName: '上海示例公司', invoiceCategory: '租赁服务费', entryMode: 'linkedOrders', invoiceAmount: 0, linkedOrders: [], applyDate: '2026-10-11', applicant: '操作人', shopName: '示例店铺', status: 'unpaid', taxId: '', registeredAddress: '', contactPhone: '', bankName: '', bankAccount: '', bankCode: '' });
  const [viewer, setViewer] = useState('');
  return <main style={{ maxWidth: 680, margin: '24px auto', padding: 24 }} className="max-w-2xl mx-auto bg-white p-6 my-6 rounded-xl border"><h1 className="text-xl font-semibold mb-6">新增发票申请 · 订单与金额</h1><label className="block mb-4">开票类目<select aria-label="开票类目" className="block border rounded p-2 mt-2 w-full" value={form.invoiceCategory} onChange={e => setForm(prev => ({ ...prev, invoiceCategory: e.target.value }))}><option>租赁服务费</option><option>二手手机</option></select></label><InvoiceOrderFields form={form} onChange={setForm} renderAttachments={files => <div className="text-sm text-blue-600">{files.map(f => f.fileName).join('、')}</div>} onViewInvoice={record => setViewer(record.companyName)} /><div>{viewer}</div><pre hidden id="state">{JSON.stringify(form)}</pre></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
