import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'tdesign-react/es/style/index.css';
import '../../src/styles/index.css';
import { CustomerNameField } from '../../src/components/CustomerNameField';
import type { CustomerOrderLinkValue } from '../../src/components/CustomerOrderLinkFields';
import { callFunction } from './mock';

const blank: CustomerOrderLinkValue = { customerName: '', customerId: '', customerAliasId: '', recipientProfileId: '', consignee: '', consigneePhone: '', consigneeAddress: '' };
const original = { ...blank, customerName: '旧订单名称', customerId: 'old', consignee: '原收件人', consigneePhone: '13900000000', consigneeAddress: '原订单地址 1 号' };
function Preview() {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(blank);
  const [message, setMessage] = useState('');
  return <main className="min-h-screen bg-gray-100 p-6 text-gray-800">
    <div className="mx-auto max-w-4xl">
      <p className="mb-4 text-sm text-gray-500">本地交互验证 · 使用虚构客户和内存订单，不连接云端</p>
      <div className="flex gap-3 mb-4">{[false, true].map(mode => <button key={String(mode)} className="rounded-lg border bg-white px-4 py-2" onClick={() => { setEditing(mode); setValue(mode ? original : blank); setMessage(''); }}>{mode ? '编辑已有订单' : '新建订单'}</button>)}</div>
      <section className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold mb-6">{editing ? '编辑订单' : '新建订单'}</h1>
        <p className="text-sm text-gray-500 mb-6">基础信息　 →　订单属性　 →　货品信息　 →　收件人信息　 →　确认预览</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div><label className="block text-xs text-gray-500 mb-1">日期 *</label><input type="date" defaultValue="2026-09-11" className="w-full h-10 rounded-lg border border-gray-300 px-3" /></div>
          <CustomerNameField key={String(editing)} value={value} salesChannel="微信" onChange={patch => setValue(current => ({ ...current, ...patch }))} />
          <div><label className="block text-xs text-gray-500 mb-1">销售人员 *</label><select className="w-full h-10 rounded-lg border border-gray-300 px-3"><option>示例人员</option></select></div>
        </div>
        <div className="mt-10 border-t pt-5"><h2 className="text-sm font-medium mb-3">本次订单收件信息</h2><div className="grid sm:grid-cols-2 gap-3">
          {(['consignee', 'consigneePhone', 'consigneeAddress'] as const).map((field, index) => <label className={index === 2 ? 'sm:col-span-2 text-xs text-gray-500' : 'text-xs text-gray-500'} key={field}>{['收件人', '电话', '地址'][index]}<input aria-label={['收件人', '电话', '地址'][index]} className="mt-1 block h-10 rounded-lg border border-gray-300 px-3 w-full text-sm" value={value[field]} onChange={event => setValue(current => ({ ...current, [field]: event.target.value }))} /></label>)}
        </div></div>
        <div className="mt-8 flex justify-end"><button className="rounded-lg bg-blue-600 px-5 py-2 text-white" onClick={async () => {
          const result = await callFunction<{ success: boolean; errMsg?: string }>('previewSave', { ...value, editing });
          setMessage(result.success ? '保存成功' : result.errMsg || '保存失败');
        }}>保存到本地测试订单</button></div>
        <p role="status" className="mt-3 text-sm text-green-700">{message}</p>
      </section>
      <p className="mt-4 text-xs text-gray-500">输入“长城”查看 3 位推荐；输入“异常”模拟查询失败；输入其他名称验证自由填写。</p>
      <pre aria-label="本次选择" className="mt-4 p-3 bg-white rounded-lg text-xs overflow-auto">{JSON.stringify(value, null, 2)}</pre>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
