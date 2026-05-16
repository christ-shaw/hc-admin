import React from 'react';
import ReactDOMClient from 'react-dom/client';
import 'tdesign-react/dist/tdesign.min.css';
import App from './App';
import './styles/index.css';

// CJS 互操作兼容：Vite 预构建的 CJS 模块可能只有 { default: {...} } 而非命名导出
const R = (React as any).default || React;
const RDC = (ReactDOMClient as any).default || ReactDOMClient;

const createRoot = RDC.createRoot;
const StrictMode = R.StrictMode;

createRoot(document.getElementById('root')!).render(
  R.createElement(StrictMode, null, R.createElement(App))
);
