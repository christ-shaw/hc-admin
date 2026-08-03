import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  Building2,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Receipt,
  Settings,
  ShoppingCart,
  Smartphone,
  Truck,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';

function lazyNamed<T extends Record<string, ComponentType<unknown>>>(
  importer: () => Promise<T>,
  name: keyof T,
) {
  return lazy(() => importer().then(module => ({ default: module[name] })));
}

export interface AppRouteMeta {
  path: string;
  label: string;
  Icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType<unknown>>;
  closable: boolean;
}

const Dashboard = lazyNamed(() => import('../pages/Dashboard'), 'Dashboard');
const InboundList = lazyNamed(() => import('../pages/InboundList'), 'InboundList');
const OutboundList = lazyNamed(() => import('../pages/OutboundList'), 'OutboundList');
const Inventory = lazyNamed(() => import('../pages/Inventory'), 'Inventory');
const Stats = lazyNamed(() => import('../pages/Stats'), 'Stats');
const Logs = lazyNamed(() => import('../pages/Logs'), 'Logs');
const PhoneModels = lazyNamed(() => import('../pages/PhoneModels'), 'PhoneModels');
const Orders = lazyNamed(() => import('../pages/Orders'), 'Orders');
const SfExpress = lazyNamed(() => import('../pages/SfExpress'), 'SfExpress');
const Purchases = lazyNamed(() => import('../pages/Purchases'), 'Purchases');
const Invoices = lazyNamed(() => import('../pages/Invoices'), 'Invoices');
const Companies = lazyNamed(() => import('../pages/Companies'), 'Companies');
const SettingsPage = lazyNamed(() => import('../pages/Settings'), 'SettingsPage');

export const appRoutes: AppRouteMeta[] = [
  { path: '/', label: '首页', Icon: LayoutDashboard, Component: Dashboard, closable: false },
  { path: '/inbound', label: '入库记录', Icon: ArrowDownCircle, Component: InboundList, closable: true },
  { path: '/outbound', label: '出库记录', Icon: ArrowUpCircle, Component: OutboundList, closable: true },
  { path: '/inventory', label: '库存管理', Icon: Warehouse, Component: Inventory, closable: true },
  { path: '/stats', label: '统计分析', Icon: BarChart3, Component: Stats, closable: true },
  { path: '/logs', label: '操作日志', Icon: FileText, Component: Logs, closable: true },
  { path: '/models', label: '型号管理', Icon: Smartphone, Component: PhoneModels, closable: true },
  { path: '/orders', label: '订单管理', Icon: ShoppingCart, Component: Orders, closable: true },
  { path: '/sf-express', label: '顺丰快递', Icon: Truck, Component: SfExpress, closable: true },
  { path: '/purchases', label: '采购管理', Icon: ClipboardList, Component: Purchases, closable: true },
  { path: '/invoices', label: '开票管理', Icon: FileText, Component: Invoices, closable: true },
  { path: '/companies', label: '公司信息', Icon: Building2, Component: Companies, closable: true },
  { path: '/settings', label: '系统设置', Icon: Settings, Component: SettingsPage, closable: true },
];

export interface AppNavGroup {
  label: string;
  Icon: LucideIcon;
  children: AppRouteMeta[];
}

export type AppNavItem = AppRouteMeta | AppNavGroup;

const routeMap = new Map(appRoutes.map(route => [route.path, route]));

export function getAppRoute(path: string) {
  const normalized = path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path;
  return routeMap.get(normalized);
}

function route(path: string) {
  return routeMap.get(path)!;
}

export const appNavigation: AppNavItem[] = [
  route('/'),
  route('/inbound'),
  route('/outbound'),
  route('/inventory'),
  route('/stats'),
  route('/logs'),
  route('/models'),
  route('/orders'),
  route('/sf-express'),
  route('/purchases'),
  { label: '发票', Icon: Receipt, children: [route('/invoices'), route('/companies')] },
  route('/settings'),
];

export function isAppNavGroup(item: AppNavItem): item is AppNavGroup {
  return 'children' in item;
}
