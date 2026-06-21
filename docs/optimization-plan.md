# HC-Admin 系统功能优化改进文档

> 版本：v1.0  
> 日期：2026-06-21  
> 基于对系统 14 个页面、8 个组件、28 个云函数、10 个 Hooks 的全面分析

---

## 目录

1. [现状概览](#1-现状概览)
2. [问题分析](#2-问题分析)
3. [优化方案](#3-优化方案)
4. [实施计划](#4-实施计划)
5. [风险评估](#5-风险评估)

---

## 1. 现状概览

### 1.1 系统架构

| 维度 | 现状 |
|------|------|
| 前端框架 | React 18 + TypeScript + Vite |
| UI 组件库 | TDesign React |
| 路由 | React Router v6（HashRouter） |
| 后端 | CloudBase（云函数 + 文档数据库 + 云存储） |
| 认证 | CloudBase Auth（用户名/密码） |
| 权限 | RBAC 双层权限（页面权限 + 功能权限） |

### 1.2 功能模块

| 模块 | 页面 | 核心功能 |
|------|------|----------|
| 首页仪表盘 | Dashboard | 统计概览、发货趋势图、热门型号排行 |
| 入库管理 | InboundList | 入库记录 CRUD、渠道类型筛选、详情查看 |
| 出库管理 | OutboundList | 出库记录 CRUD、详情查看 |
| 库存管理 | Inventory | Excel 上传解析、三仓库存（半成品/成品/维修仓） |
| 统计分析 | Stats | 7 天入出库趋势、型号级统计 |
| 操作日志 | Logs | 创建/更新/删除操作记录、修改历史 |
| 型号管理 | PhoneModels | 品牌/型号增删管理 |
| 订单管理 | Orders | 6 步表单向导、Excel 导入导出、顺丰快递集成、发货/售后确认 |
| 开票管理 | Invoices | 4 步开票表单、发票图片上传、公司信息关联 |
| 公司信息 | Companies | 开票模板 CRUD、AI 智能解析 |
| 系统设置 | Settings | AI 模型配置、序号计数器、权限管理、登录日志 |
| 权限系统 | - | 角色管理、用户角色分配、页面/功能权限控制 |

### 1.3 代码规模

| 文件 | 行数 | 大小 | 复杂度 |
|------|------|------|--------|
| Orders.tsx | 2400+ | 120 KB | 极高（40+ useState） |
| Invoices.tsx | 1500+ | 73 KB | 高 |
| 其他页面 | 100-400 | 5-16 KB | 中低 |
| 云函数总数 | 28 个 | - | - |
| 数据字典 | 1 个 | dict.ts | 统一数据源 |

---

## 2. 问题分析

### 2.1 安全性问题（P0 — 必须修复）

#### 2.1.1 云函数缺少服务端鉴权

**现状：** 前端有完整的权限控制（页面过滤 + 路由守卫），但**所有业务云函数均未校验调用者的功能权限**。

**风险：** 任何登录用户都可以通过浏览器控制台直接调用云函数，绕过前端权限控制执行越权操作。

**受影响的云函数（17 个）：**

| 云函数 | 应校验权限 | 当前状态 |
|--------|-----------|----------|
| `saveOrders` | `orders:create` | ❌ 未校验 |
| `updateOrder` | `orders:update` | ❌ 未校验 |
| `deleteOrder` | `orders:delete` | ❌ 未校验 |
| `saveInvoice` | `invoices:create` | ❌ 未校验 |
| `updateInvoice` | `invoices:update` | ❌ 未校验 |
| `deleteInvoice` | `invoices:delete` | ❌ 未校验 |
| `saveCompany` | `companies:write` | ❌ 未校验 |
| `updateCompany` | `companies:write` | ❌ 未校验 |
| `deleteCompany` | `companies:write` | ❌ 未校验 |
| `manageCounter` | `settings:update` | ❌ 未校验 |
| `applySfExpress` | `orders:update` | ❌ 未校验 |
| `cancelSfExpress` | `orders:update` | ❌ 未校验 |
| `getCloudFileUrls` | 登录态即可 | ❌ 未校验 |
| `queryOrders` | `orders:read` | ❌ 未校验 |
| `queryInvoices` | `invoices:read` | ❌ 未校验 |
| `queryCompanies` | `companies:read` | ❌ 未校验 |
| `generateDailyShipmentStats` | 内部定时任务 | ❌ 未校验 |

#### 2.1.2 前端按钮级权限未实现

**现状：** `actionPermissions` 已定义 20+ 个功能权限点（如 `orders:create`、`inbound:delete`），但页面上的新增/编辑/删除按钮对所有有页面访问权限的用户都可见。

**影响：** 用户能看到自己无权操作的按钮，点击后才会被云函数拒绝（如果加了服务端鉴权），体验差。

---

### 2.2 代码可维护性问题（P1）

#### 2.2.1 超大文件难以维护

| 文件 | 问题 |
|------|------|
| `Orders.tsx`（120 KB） | 2400+ 行，40+ useState，6 步表单 + 导入 + 导出 + 发货 + 售后全部在一个文件，修改任何功能都要在巨大文件中定位 |
| `Invoices.tsx`（73 KB） | 1500+ 行，4 步表单 + 搜索 + 详情 + 编辑全在一个文件 |

#### 2.2.2 状态管理混乱

`Orders.tsx` 中 40+ 个 `useState` 管理着：
- 列表数据 + 分页 + 筛选
- 新增表单（6 步状态 + 30+ 字段）
- 编辑表单（同上）
- 导入弹窗状态
- 导出弹窗状态
- 发货弹窗状态
- 售后弹窗状态
- 各种 loading 状态

这些状态相互耦合，任意一个 `setState` 都可能触发整个组件重渲染。

#### 2.2.3 缺少 TypeScript 类型定义

- `cloudbase.ts` 中大量 `any` 类型（已 eslint-disable）
- 云函数返回值无类型定义
- 前端调用云函数时类型不安全

---

### 2.3 性能问题（P1-P2）

#### 2.3.1 列表页缺少 useMemo 优化

以下页面的 Table `columns` 数组每次渲染都重建：

| 页面 | columns 定义方式 | 问题 |
|------|-----------------|------|
| InboundList.tsx | 内联数组 | 每次渲染重建 |
| OutboundList.tsx | 内联数组 | 每次渲染重建 |
| Inventory.tsx | 内联数组 | 每次渲染重建 |
| Companies.tsx | 内联数组 | 每次渲染重建 |
| Stats.tsx | 内联数组 | 每次渲染重建 |
| Logs.tsx | 内联数组 | 每次渲染重建 |

> 对比：Orders.tsx、RoleManageTab.tsx 已正确使用 `useMemo`。

#### 2.3.2 图片串行加载

`RecordDetail.tsx` 中获取云存储图片 URL 使用 `for...of` 串行请求：

```typescript
// 当前：串行，N 张图片需要 N 次往返
for (const file of files) {
  const url = await getFileURL(file);  // 逐个等待
  setUrls(prev => [...prev, url]);     // 逐个触发渲染
}
```

**影响：** 5 张图片加载时间 = 5 × 单次请求时间，且触发 5 次 state 更新。

#### 2.3.3 权限信息重复加载

`PermissionContext` 在每次路由变化时都可能触发 `getUserRole` 云函数调用，没有缓存机制。

---

### 2.4 用户体验问题（P2-P3）

#### 2.4.1 空状态不统一

| 页面 | 空状态处理 |
|------|-----------|
| Stats | ✅ 有自定义提示 |
| Orders | ✅ 导出/发货/售后有空状态 |
| InboundList | ❌ 依赖 TDesign Table 默认 |
| OutboundList | ❌ 依赖 TDesign Table 默认 |
| Inventory | ❌ 依赖 TDesign Table 默认 |
| Logs | ❌ 依赖 TDesign Table 默认 |

#### 2.4.2 表单体验不足

- 6 步表单无步骤完成度指示（已完成步骤无法打勾标记）
- 表单填写中途切换步骤无未保存提示
- 长表单无自动暂存（意外刷新丢失所有输入）

#### 2.4.3 分页体验

Orders 页面使用手动上一页/下一页按钮，未使用 TDesign Table 内置分页组件，交互不直观。

---

## 3. 优化方案

### 3.1 安全性优化（P0）

#### 3.1.1 云函数统一鉴权中间件

**目标：** 所有业务云函数在执行前校验调用者的功能权限。

**方案：** 抽取公共鉴权逻辑到 `permissionAuth.js`，所有业务云函数引入复用。

**新增文件：** `cloud_functions/shared/permissionGuard.js`

```javascript
// 统一鉴权工具
async function requirePermission(event, actionPermission) {
  // 1. 获取当前登录用户
  const currentUser = await getCurrentUser(event);
  if (!currentUser) {
    return { allowed: false, error: { code: 'LOGIN_REQUIRED', errMsg: '请先登录' } };
  }

  // 2. 查询用户角色和权限
  const permission = await loadUserPermission(currentUser.id);
  if (!permission.initialized) {
    return { allowed: false, error: { code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' } };
  }
  if (!permission.role) {
    return { allowed: false, error: { code: 'ROLE_UNASSIGNED', errMsg: '未分配角色' } };
  }

  // 3. 校验功能权限
  const actions = permission.role.actionPermissions || [];
  if (!actions.includes('*') && !actions.includes(actionPermission)) {
    return { allowed: false, error: { code: 'ACCESS_DENIED', errMsg: '无权执行该操作' } };
  }

  return { allowed: true, currentUser, permission };
}

// 业务云函数中使用
exports.main = async (event) => {
  const auth = await requirePermission(event, 'orders:create');
  if (!auth.allowed) return { success: false, ...auth.error };

  // 正常业务逻辑...
};
```

**改造范围：** 17 个业务云函数（见 2.1.1 节列表）。

#### 3.1.2 前端按钮级权限控制

**目标：** 根据 `actionPermissions` 动态显示/隐藏操作按钮。

**方案：** 封装 `PermissionButton` 组件和 `useCan` Hook。

**新增文件：** `src/components/PermissionButton.tsx`

```tsx
import { usePermission } from '../hooks/usePermission';

interface PermissionButtonProps {
  action: string;          // 功能权限点，如 'orders:create'
  children: React.ReactNode;
  fallback?: React.ReactNode;  // 无权限时的替代内容（默认 null）
}

export function PermissionButton({ action, children, fallback = null }: PermissionButtonProps) {
  const { can, status } = usePermission();
  if (status !== 'ready') return <>{fallback}</>;
  if (!can(action)) return <>{fallback}</>;
  return <>{children}</>;
}
```

**使用示例：**

```tsx
// Orders.tsx 中
<PermissionButton action="orders:create">
  <Button theme="primary" icon={<Plus />} onClick={openAdd}>新增订单</Button>
</PermissionButton>

<PermissionButton action="orders:update">
  <Button variant="text" onClick={() => openEdit(row)}>编辑</Button>
</PermissionButton>

<PermissionButton action="orders:delete">
  <Button variant="text" theme="danger" onClick={() => handleDelete(row)}>删除</Button>
</PermissionButton>
```

**改造范围：** Orders、InboundList、OutboundList、Invoices、Companies、PhoneModels、Settings 等页面的所有操作按钮。

---

### 3.2 代码架构优化（P1）

#### 3.2.1 Orders.tsx 拆分

**目标：** 将 120 KB 单文件拆分为 6 个子组件，每个文件 200-400 行。

**目录结构：**

```
src/pages/Orders/
├── index.tsx                    # 主页面：列表 + 搜索 + 分页 + 弹窗入口（~300 行）
├── OrderFormWizard.tsx          # 新增/编辑 6 步向导（~500 行）
├── OrderImportDialog.tsx        # Excel 批量导入弹窗（~200 行）
├── OrderExportDialog.tsx        # Excel 导出 3 步向导（~200 行）
├── ShipConfirmDialog.tsx        # 发货确认弹窗（~250 行）
├── AfterSaleDialog.tsx          # 售后入库确认弹窗（~200 行）
├── OrderDetailDialog.tsx        # 订单详情查看弹窗（~200 行）
└── types.ts                     # 订单相关类型定义（~80 行）
```

**拆分原则：**
- 每个弹窗/向导独立一个文件
- 主页面只负责列表展示和弹窗开关状态
- 共享类型抽取到 `types.ts`
- 共享工具函数抽取到 `utils.ts`

#### 3.2.2 Invoices.tsx 拆分

**目录结构：**

```
src/pages/Invoices/
├── index.tsx                    # 主页面：列表 + 搜索 + 分页
├── InvoiceFormWizard.tsx        # 4 步开票向导
├── InvoiceDetailDialog.tsx      # 发票详情查看
└── types.ts                     # 类型定义
```

#### 3.2.3 表单状态管理优化

**目标：** 将 Orders 表单的 40+ useState 改用 `useReducer` 集中管理。

**方案：**

```typescript
// OrderFormWizard.tsx
interface FormState {
  step: number;
  basicInfo: { serialNumber: number; date: string; ... };
  orderAttr: { orderSource: string; orderAttribute: string; ... };
  products: ProductItem[];
  consignee: { consignee: string; phone: string; address: string; ... };
  remarks: { customerRemark: string; attachments: OrderAttachment[] };
  transferProducts: TransferProductItem[];
}

type FormAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'UPDATE_BASIC'; patch: Partial<FormState['basicInfo']> }
  | { type: 'ADD_PRODUCT'; product: ProductItem }
  | { type: 'UPDATE_PRODUCT'; index: number; patch: Partial<ProductItem> }
  | { type: 'REMOVE_PRODUCT'; index: number }
  | { type: 'RESET' }
  | ...

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, step: action.step };
    case 'UPDATE_BASIC':
      return { ...state, basicInfo: { ...state.basicInfo, ...action.patch } };
    // ...
  }
}
```

---

### 3.3 性能优化（P1-P2）

#### 3.3.1 列表页 useMemo 补全

**改造范围：** 6 个页面

**改造方式：**

```typescript
// 改造前
const columns = [
  { colKey: 'name', title: '名称' },
  { colKey: 'op', cell: ({ row }) => <Button onClick={() => handleEdit(row)}>编辑</Button> },
];

// 改造后
const columns = useMemo(() => [
  { colKey: 'name', title: '名称' },
  { colKey: 'op', cell: ({ row }) => <Button onClick={() => handleEdit(row)}>编辑</Button> },
], [handleEdit]);
```

#### 3.3.2 图片并行加载

**改造文件：** `RecordDetail.tsx`

```typescript
// 改造前：串行
for (const file of files) {
  const url = await getFileURL(file);
  setUrls(prev => [...prev, url]);
}

// 改造后：并行
const urls = await Promise.all(files.map(file => getFileURL(file).catch(() => null)));
setUrls(urls.filter(Boolean));
```

#### 3.3.3 权限信息缓存

**改造文件：** `PermissionContext.tsx`

```typescript
const PERMISSION_CACHE_KEY = 'hc_admin_permission_cache';
const PERMISSION_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// 加载权限时优先读缓存
async function loadPermission() {
  // 1. 尝试从 sessionStorage 读缓存
  const cached = sessionStorage.getItem(PERMISSION_CACHE_KEY);
  if (cached) {
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < PERMISSION_CACHE_TTL) {
      return data;
    }
  }
  // 2. 缓存过期或不存在，调用云函数
  const result = await callFunction('getUserRole', { currentUser });
  // 3. 写入缓存
  sessionStorage.setItem(PERMISSION_CACHE_KEY, JSON.stringify({
    data: result,
    timestamp: Date.now(),
  }));
  return result;
}
```

---

### 3.4 用户体验优化（P2-P3）

#### 3.4.1 统一空状态组件

**新增文件：** `src/components/EmptyState.tsx`

```tsx
interface EmptyStateProps {
  icon?: React.ReactNode;      // 默认 📦
  title: string;               // 如"暂无入库记录"
  description?: string;        // 如"点击右上角新增按钮添加"
  action?: React.ReactNode;    // 可选操作按钮
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-5xl mb-4">{icon || '📦'}</div>
      <h3 className="text-base font-medium text-gray-600">{title}</h3>
      {description && <p className="text-sm text-gray-400 mt-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

#### 3.4.2 表单步骤完成度指示

**改造文件：** `OrderFormWizard.tsx`

```tsx
// 步骤指示器增加完成标记
{STEPS.map((step, i) => (
  <div key={i} className={`step-item ${i < currentStep ? 'completed' : ''} ${i === currentStep ? 'active' : ''}`}>
    {i < currentStep ? <CheckCircle size={16} /> : <span>{i + 1}</span>}
    <span>{step.title}</span>
  </div>
))}
```

#### 3.4.3 表单草稿暂存

**目标：** 表单填写过程中自动保存到 localStorage，意外刷新后可恢复。

```typescript
// 自动暂存（每 5 秒或步骤切换时）
useEffect(() => {
  const timer = setTimeout(() => {
    localStorage.setItem('order_form_draft', JSON.stringify(form));
  }, 5000);
  return () => clearTimeout(timer);
}, [form]);

// 页面加载时检查草稿
useEffect(() => {
  const draft = localStorage.getItem('order_form_draft');
  if (draft) {
    Dialog.confirm({
      content: '检测到未完成的草稿，是否恢复？',
      onConfirm: () => {
        setForm(JSON.parse(draft));
      },
    });
  }
}, []);
```

#### 3.4.4 分页组件统一

Orders 页面从手动上一页/下一页改为 TDesign Table 内置分页：

```tsx
<Table
  data={orders}
  columns={columns}
  pagination={{
    current: currentPage,
    pageSize,
    total,
    onChange: (page) => loadPage(page),
  }}
/>
```

---

## 4. 实施计划

### 4.1 阶段划分

| 阶段 | 内容 | 预计工作量 | 优先级 |
|------|------|-----------|--------|
| **阶段 1** | 云函数服务端鉴权 | 2-3 天 | P0 |
| **阶段 2** | 前端按钮级权限控制 | 1-2 天 | P0 |
| **阶段 3** | Orders.tsx 拆分 | 3-5 天 | P1 |
| **阶段 4** | 列表页 useMemo 优化 | 1 天 | P1 |
| **阶段 5** | 图片并行加载 + 权限缓存 | 0.5 天 | P2 |
| **阶段 6** | 空状态统一组件 | 0.5 天 | P2 |
| **阶段 7** | 表单体验优化（步骤指示 + 草稿暂存） | 2 天 | P3 |
| **阶段 8** | Invoices.tsx 拆分 | 2-3 天 | P3 |

### 4.2 阶段 1 详细计划：云函数服务端鉴权

| 步骤 | 内容 | 说明 |
|------|------|------|
| 1.1 | 创建 `shared/permissionGuard.js` | 统一鉴权工具，支持 `requirePermission(event, action)` |
| 1.2 | 改造订单相关云函数（4 个） | saveOrders、updateOrder、deleteOrder、queryOrders |
| 1.3 | 改造发票相关云函数（4 个） | saveInvoice、updateInvoice、deleteInvoice、queryInvoices |
| 1.4 | 改造公司相关云函数（4 个） | saveCompany、updateCompany、deleteCompany、queryCompanies |
| 1.5 | 改造其他云函数（5 个） | manageCounter、applySfExpress、cancelSfExpress、getCloudFileUrls、generateDailyShipmentStats |
| 1.6 | 统一部署 + 测试 | 确保所有云函数鉴权正常 |

### 4.3 阶段 2 详细计划：按钮级权限控制

| 步骤 | 内容 |
|------|------|
| 2.1 | 创建 `PermissionButton` 组件 |
| 2.2 | Orders 页面所有操作按钮包裹 `PermissionButton` |
| 2.3 | InboundList / OutboundList 操作按钮包裹 |
| 2.4 | Invoices / Companies 操作按钮包裹 |
| 2.5 | PhoneModels / Settings 操作按钮包裹 |
| 2.6 | 测试不同角色看到的按钮差异 |

### 4.4 阶段 3 详细计划：Orders.tsx 拆分

| 步骤 | 内容 |
|------|------|
| 3.1 | 创建 `src/pages/Orders/` 目录和 `types.ts` |
| 3.2 | 抽取 `OrderFormWizard` 组件（6 步表单） |
| 3.3 | 抽取 `OrderImportDialog` 组件 |
| 3.4 | 抽取 `OrderExportDialog` 组件 |
| 3.5 | 抽取 `ShipConfirmDialog` 组件 |
| 3.6 | 抽取 `AfterSaleDialog` 组件 |
| 3.7 | 抽取 `OrderDetailDialog` 组件 |
| 3.8 | 主页面 `index.tsx` 只保留列表和弹窗入口 |
| 3.9 | 表单状态改用 `useReducer` |
| 3.10 | 全面回归测试 |

---

## 5. 风险评估

### 5.1 风险矩阵

| 风险 | 概率 | 影响 | 应对措施 |
|------|------|------|----------|
| 云函数加鉴权后影响现有功能 | 中 | 高 | 逐个改造、逐个部署、充分测试 |
| Orders 拆分后引入 bug | 中 | 高 | 拆分时保持逻辑不变，仅移动代码位置；拆分后全面回归测试 |
| useReducer 重构引入状态 bug | 低 | 中 | 保持初始状态结构不变，仅改变管理方式 |
| 权限缓存导致角色变更不及时 | 低 | 中 | 缓存 TTL 设为 5 分钟，角色变更后主动清除缓存 |
| 前端按钮隐藏后用户困惑 | 低 | 低 | 提供 fallback 提示"无权限" |

### 5.2 回滚方案

| 优化项 | 回滚方式 |
|--------|----------|
| 云函数鉴权 | 移除 `requirePermission` 调用，重新部署 |
| 按钮级权限 | 移除 `PermissionButton` 包裹 |
| Orders 拆分 | git revert 回到拆分前版本 |
| useMemo 优化 | 移除 `useMemo` 包裹 |
| 权限缓存 | 移除 sessionStorage 读写逻辑 |

### 5.3 测试策略

- **云函数鉴权：** 用不同角色账号调用每个云函数，验证权限校验
- **按钮级权限：** 用财务角色（只有 4 个页面权限）登录，验证不可见按钮确实隐藏
- **Orders 拆分：** 拆分后逐个功能测试（新增、编辑、导入、导出、发货、售后、删除）
- **性能优化：** 对比优化前后的渲染次数和加载时间

---

## 附录：改造文件清单

### 新增文件

| 文件路径 | 说明 |
|----------|------|
| `cloud_functions/shared/permissionGuard.js` | 云函数统一鉴权工具 |
| `src/components/PermissionButton.tsx` | 按钮级权限控制组件 |
| `src/components/EmptyState.tsx` | 统一空状态组件 |
| `src/pages/Orders/types.ts` | 订单类型定义 |
| `src/pages/Orders/OrderFormWizard.tsx` | 订单表单向导 |
| `src/pages/Orders/OrderImportDialog.tsx` | 订单导入弹窗 |
| `src/pages/Orders/OrderExportDialog.tsx` | 订单导出弹窗 |
| `src/pages/Orders/ShipConfirmDialog.tsx` | 发货确认弹窗 |
| `src/pages/Orders/AfterSaleDialog.tsx` | 售后确认弹窗 |
| `src/pages/Orders/OrderDetailDialog.tsx` | 订单详情弹窗 |
| `src/pages/Invoices/types.ts` | 发票类型定义 |
| `src/pages/Invoices/InvoiceFormWizard.tsx` | 发票表单向导 |
| `src/pages/Invoices/InvoiceDetailDialog.tsx` | 发票详情弹窗 |

### 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| 17 个业务云函数 `index.js` | 添加 `requirePermission` 鉴权 |
| `src/pages/Orders.tsx` → `src/pages/Orders/index.tsx` | 拆分为子组件 |
| `src/pages/Invoices.tsx` → `src/pages/Invoices/index.tsx` | 拆分为子组件 |
| `src/pages/InboundList.tsx` | useMemo 优化 + PermissionButton |
| `src/pages/OutboundList.tsx` | useMemo 优化 + PermissionButton |
| `src/pages/Inventory.tsx` | useMemo 优化 |
| `src/pages/Companies.tsx` | useMemo 优化 + PermissionButton |
| `src/pages/Stats.tsx` | useMemo 优化 |
| `src/pages/Logs.tsx` | useMemo 优化 |
| `src/pages/PhoneModels.tsx` | PermissionButton |
| `src/pages/Settings.tsx` | PermissionButton |
| `src/components/RecordDetail.tsx` | 图片并行加载 |
| `src/contexts/PermissionContext.tsx` | 权限缓存 |
| `src/App.tsx` | 路由路径更新（Orders/Invoices 目录化） |
