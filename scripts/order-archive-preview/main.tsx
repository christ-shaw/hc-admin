import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'tdesign-react/es/style/index.css';
import '../../src/styles/index.css';
import { CustomerNameField } from '../../src/components/CustomerNameField';
import { OrderCustomerArchiveOption } from '../../src/components/OrderCustomerArchiveOption';
import { useOrderCustomerArchive } from '../../src/hooks/useOrderCustomerArchive';
import type { CustomerOrderLinkValue } from '../../src/components/CustomerOrderLinkFields';
import { callFunction } from './mock';

const blank: CustomerOrderLinkValue = { customerName: '', customerId: '', customerAliasId: '', recipientProfileId: '',
  consignee: '', consigneePhone: '', consigneeAddress: '' };
function Preview() {
  const [form, setForm] = useState(blank);
  const [choice, setChoice] = useState<boolean>();
  const [result, setResult] = useState('');
  const plan = useOrderCustomerArchive(!form.customerId, { customerName: form.customerName, consignee: form.consignee,
    phone: form.consigneePhone, address: form.consigneeAddress }, choice);
  const change = (patch: Partial<CustomerOrderLinkValue>) => setForm(previous => ({ ...previous, ...patch }));
  return <main className="min-h-screen bg-gray-100 p-6 text-gray-800">
    <section className="mx-auto max-w-2xl rounded-xl bg-white p-6 shadow-sm">
      <p className="mb-4 text-xs text-gray-500">本地交互验证 · 虚构客户与内存订单，不连接云端</p>
      <h1 className="mb-6 text-xl font-semibold">新建订单 · 随单建档</h1>
      <CustomerNameField value={form} salesChannel="微信" onChange={patch => {
        if (patch.customerName !== undefined && patch.customerName !== form.customerName) setChoice(undefined);
        change(patch);
      }} />
      <OrderCustomerArchiveOption plan={plan} onChoice={setChoice} onSelect={change} />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(['consignee', 'consigneePhone', 'consigneeAddress'] as const).map((field, index) => <label key={field} className="text-xs text-gray-500">
          {['收件人', '电话', '地址'][index]}<input aria-label={['收件人', '电话', '地址'][index]} className="mt-1 block h-10 w-full rounded-lg border px-3 text-sm"
            value={form[field]} onChange={event => change({ [field]: event.target.value })} />
        </label>)}
      </div>
      <p className="mt-5 text-sm">确认预览：{form.customerId ? '已关联' : plan.checked ? '保存订单时一并建立客户档案' : '订单保存后待归档'}</p>
      <div className="mt-6 flex gap-3"><button className="rounded-lg border px-4 py-2 text-sm" onClick={() => { setForm(blank); setChoice(undefined); }}>取消录单</button>
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={plan.checking || !form.customerName.trim()} onClick={async () => {
          const saved = await callFunction('saveOrders', { data: { orders: [{ ...form, createCustomerArchive: plan.checked,
            orderAttribute: 'rental1', salesChannel: '微信', customerSelectionMode: form.customerId ? 'explicit' : 'none' }] } });
          setResult(JSON.stringify({ saved, database: await callFunction('inspect', {}) }, null, 2));
        }}>保存到本地测试订单</button></div>
      <p className="mt-4 text-xs text-gray-500">输入“示例老客户”查看相似档案；其他名称验证新客户默认勾选。</p>
      <pre role="status" className="mt-4 max-h-80 overflow-auto text-xs">{result}</pre>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
