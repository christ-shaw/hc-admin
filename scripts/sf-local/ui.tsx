import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'tdesign-react/es/style/index.css';
import '../../src/styles/index.css';
import { SfExpress } from '../../src/pages/SfExpress';
import { callFunction } from './ui-mocks';

function Preview() {
  return <main className="min-h-screen bg-gray-100 p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div><strong>本地模拟调试</strong> · 使用真实顺丰页面及本地云函数代码，不连接线上数据或真实顺丰。
        <p className="mt-1">LOCAL-001、002、004、005、006 可合并；LOCAL-003 为已打印面单，可直接追加。打印会生成带 LOCAL TEST 标记的模拟 PDF。</p>
      </div>
      <button className="rounded border border-amber-400 px-3 py-2" onClick={async () => {
        await callFunction('reset'); window.location.reload();
      }}>重置测试数据</button>
    </div>
    <SfExpress />
  </main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Preview /></BrowserRouter>);
