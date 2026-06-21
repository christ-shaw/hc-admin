# HC-Admin 权限管理系统设计文档

## 1. 概述

为 HC-Admin 系统引入基于角色的访问控制（RBAC），实现不同用户根据角色看到不同菜单、访问不同页面，并在云函数层限制真实数据读写操作。

权限系统的边界分为两层：

- 前端菜单过滤、按钮隐藏、路由拦截：负责用户体验，减少误操作。
- 云函数服务端鉴权：负责真正的安全边界，所有敏感数据读写必须校验功能权限。

### 1.1 现状分析

| 维度 | 现状 |
|------|------|
| 认证方式 | CloudBase Auth 用户名/密码登录 |
| 用户信息来源 | `getCurrentUser()` 返回当前登录用户 |
| 导航菜单 | `Layout.tsx` 中硬编码静态数组 `navItems` |
| 路由守卫 | `AuthGuard.tsx` 仅校验登录态，无角色检查 |
| 云函数权限 | 现有云函数主要校验参数和登录态，缺少业务权限校验 |
| 现有角色体系 | 无 |
| 设置页面 | `Settings.tsx` 仅含 AI 模型设置 + 序号计数器，无权限管理 Tab |

### 1.2 设计目标

- 支持自定义角色，每个角色配置页面权限和功能权限。
- 用户可被分配一个角色。
- 根据页面权限动态过滤左侧导航菜单。
- 用户通过 URL 强跳无权页面时，跳转到禁止访问页。
- 根据功能权限控制按钮显示和云函数操作。
- 所有敏感云函数在服务端校验当前登录人的功能权限。
- 权限数据持久化到 CloudBase 文档数据库。
- 在系统设置页面提供角色管理和用户角色配置 UI。
- 首次上线通过 CloudBase 内置账号 `administrator` 完成初始化，避免任何登录用户都能配置权限。
- 权限加载失败、角色缺失、用户未分配角色时默认拒绝访问，不放开权限。

### 1.3 核心原则

| 原则 | 说明 |
|------|------|
| 服务端为准 | 前端权限只提升体验，云函数鉴权才是最终判断。 |
| 默认拒绝 | 除系统未初始化的引导流程外，权限异常时默认拒绝访问。 |
| 显式初始化 | 仅 CloudBase 内置账号 `administrator` 可创建首个管理员。 |
| 权限分层 | 页面权限控制菜单和路由，功能权限控制按钮和云函数操作。 |
| 防止锁死 | 禁止删除最后一个管理员，禁止最后一个管理员失去角色管理权限。 |

---

## 2. 数据模型设计

### 2.1 CloudBase 集合设计

需要新增四个集合：`roles`、`permission_users`、`user_roles`、`system_config`。

#### 集合 1：`roles`（角色定义）

```typescript
interface RoleRecord {
  _id: string;                    // 文档 ID，建议系统内置角色使用稳定 ID，如 role_admin
  name: string;                   // 角色名称，如 "管理员"、"操作员"
  code?: string;                  // 角色编码，如 admin、operator、viewer
  description?: string;           // 角色描述
  pagePermissions: string[];      // 可访问的页面路由路径列表
  actionPermissions: string[];    // 可执行的功能权限点列表
  systemRole?: boolean;           // 是否系统内置角色，内置角色不允许随意删除
  createdAt: string;              // ISO 时间戳
  updatedAt: string;              // ISO 时间戳
}
```

**管理员示例：**

```json
{
  "_id": "role_admin",
  "name": "管理员",
  "code": "admin",
  "description": "拥有全部页面和功能权限",
  "pagePermissions": ["/", "/inbound", "/outbound", "/inventory", "/stats", "/logs", "/models", "/orders", "/invoices", "/companies", "/settings"],
  "actionPermissions": ["*"],
  "systemRole": true,
  "createdAt": "2026-06-15T00:00:00Z",
  "updatedAt": "2026-06-15T00:00:00Z"
}
```

**操作员示例：**

```json
{
  "_id": "role_operator",
  "name": "操作员",
  "code": "operator",
  "description": "可处理入库、出库、订单和发票业务",
  "pagePermissions": ["/", "/inbound", "/outbound", "/orders", "/invoices", "/companies"],
  "actionPermissions": ["inbound:read", "inbound:create", "outbound:read", "outbound:create", "orders:read", "orders:create", "orders:update", "invoices:read", "invoices:create", "companies:read"],
  "createdAt": "2026-06-15T00:00:00Z",
  "updatedAt": "2026-06-15T00:00:00Z"
}
```

**查看者示例：**

```json
{
  "_id": "role_viewer",
  "name": "查看者",
  "code": "viewer",
  "description": "仅可查看指定页面和数据，不可新增、编辑、删除",
  "pagePermissions": ["/", "/inventory", "/stats", "/logs", "/models"],
  "actionPermissions": ["inventory:read", "stats:read", "logs:read", "models:read"],
  "createdAt": "2026-06-15T00:00:00Z",
  "updatedAt": "2026-06-15T00:00:00Z"
}
```

#### 集合 2：`permission_users`（本地用户列表）

从 CloudBase Auth 已注册用户列表同步生成，作为系统内可分配角色的用户列表。设置页提供“从 CloudBase 同步用户”按钮，手动拉取 CloudBase 用户并和本地集合 merge。

```typescript
interface PermissionUserRecord {
  _id: string;                    // 文档 ID，自动生成
  userId: string;                 // CloudBase Auth 用户 UID，唯一索引
  username: string;               // 登录用户名
  nickName?: string;              // 昵称
  email?: string;                 // 邮箱
  phone?: string;                 // 手机号
  source: "cloudbase";            // 用户来源
  lastSyncedAt: string;           // 最近一次从 CloudBase 同步时间
  createdAt: string;
  updatedAt: string;
}
```

`userId` 需要建立唯一索引，避免重复同步同一 CloudBase 用户。

#### 集合 3：`user_roles`（用户-角色映射）

```typescript
interface UserRoleRecord {
  _id: string;                    // 文档 ID，自动生成
  userId: string;                 // CloudBase Auth 用户 UID，唯一索引
  username: string;               // 登录用户名，冗余便于展示
  nickName?: string;              // 昵称，冗余便于展示
  roleId: string;                 // 关联 roles._id
  assignedBy?: string;            // 分配操作人 userId
  createdAt: string;              // ISO 时间戳
  updatedAt: string;              // ISO 时间戳
}
```

`userId` 需要建立唯一索引，确保一个用户只对应一个角色。分配角色前必须先确认该用户存在于 `permission_users`。

#### 集合 4：`system_config`（系统配置）

用于记录权限系统是否完成初始化。

```typescript
interface PermissionSystemConfig {
  _id: "permission_system";
  initialized: boolean;           // 是否已完成权限系统初始化
  bootstrapAdminUsername: "administrator"; // 允许初始化首个管理员的内置账号
  initializedBy?: string;         // 完成初始化的用户 ID
  initializedAt?: string;         // 初始化时间
  updatedAt: string;
}
```

### 2.2 页面权限映射

页面权限用于菜单过滤和路由守卫。

| 菜单标签 | 路由路径 | 页面权限 |
|----------|----------|----------|
| 首页 | `/` | `/` |
| 入库记录 | `/inbound` | `/inbound` |
| 出库记录 | `/outbound` | `/outbound` |
| 库存管理 | `/inventory` | `/inventory` |
| 统计分析 | `/stats` | `/stats` |
| 操作日志 | `/logs` | `/logs` |
| 型号管理 | `/models` | `/models` |
| 订单管理 | `/orders` | `/orders` |
| 开票管理 | `/invoices` | `/invoices` |
| 公司信息 | `/companies` | `/companies` |
| 系统设置 | `/settings` | `/settings` |

### 2.3 功能权限映射

功能权限用于按钮显示和云函数服务端鉴权。

| 模块 | 权限点 | 说明 |
|------|--------|------|
| 入库 | `inbound:read` | 查询入库记录 |
| 入库 | `inbound:create` | 新增入库记录 |
| 入库 | `inbound:update` | 编辑入库记录 |
| 入库 | `inbound:delete` | 删除入库记录 |
| 出库 | `outbound:read` | 查询出库记录 |
| 出库 | `outbound:create` | 新增出库记录 |
| 出库 | `outbound:update` | 编辑出库记录 |
| 出库 | `outbound:delete` | 删除出库记录 |
| 库存 | `inventory:read` | 查询库存 |
| 统计 | `stats:read` | 查看统计分析 |
| 日志 | `logs:read` | 查看操作日志 |
| 型号 | `models:read` | 查询型号 |
| 型号 | `models:write` | 新增、编辑、删除型号 |
| 订单 | `orders:read` | 查询订单 |
| 订单 | `orders:create` | 新增订单 |
| 订单 | `orders:update` | 编辑订单 |
| 订单 | `orders:delete` | 删除订单 |
| 发票 | `invoices:read` | 查询发票 |
| 发票 | `invoices:create` | 新增发票 |
| 发票 | `invoices:update` | 编辑发票 |
| 发票 | `invoices:delete` | 删除发票 |
| 公司 | `companies:read` | 查询公司信息 |
| 公司 | `companies:write` | 新增、编辑、删除公司信息 |
| 设置 | `settings:read` | 查看系统设置 |
| 设置 | `settings:update` | 修改普通系统设置 |
| 设置 | `settings:role_manage` | 管理角色 |
| 设置 | `settings:user_role_manage` | 分配用户角色 |

`actionPermissions` 支持通配符 `*`，仅管理员角色使用。

### 2.4 空权限语义

权限数组为空只表示“该角色已存在，但没有任何对应权限”。

| 状态 | 表达方式 | 处理策略 |
|------|----------|----------|
| 系统未初始化 | `system_config.permission_system.initialized === false` 或配置不存在 | 只允许 CloudBase 内置账号 `administrator` 进入初始化流程 |
| 用户未同步到本地 | `permission_users` 无当前用户记录 | 拒绝访问，提示管理员先同步 CloudBase 用户 |
| 用户未分配角色 | `user_roles` 无当前用户记录 | 拒绝访问，提示联系管理员分配角色 |
| 角色不存在 | `user_roles.roleId` 找不到对应 `roles` | 拒绝访问，提示角色配置异常 |
| 角色权限为空 | `pagePermissions: []` 且/或 `actionPermissions: []` | 视为明确无权限，不允许访问相关页面或功能 |
| 权限加载失败 | 云函数或网络异常 | 拒绝访问，提示权限加载失败，可重试 |

---

## 3. 架构设计

### 3.1 整体架构

```
浏览器客户端
  ├─ AuthGuard：校验登录态
  ├─ PermissionProvider：加载当前用户角色和权限
  ├─ AppLayout：根据 pagePermissions 过滤菜单
  ├─ PermissionGuard：根据 pagePermissions 拦截路由
  ├─ 页面按钮：根据 actionPermissions 控制可见/可点
  └─ callFunction：调用云函数
          │
          ▼
CloudBase 云函数
  ├─ 读取当前登录用户
  ├─ 查询 permission_users + user_roles + roles
  ├─ assertPermission(action)
  └─ 通过后执行数据库读写
          │
          ▼
CloudBase 文档数据库
  ├─ roles
  ├─ permission_users
  ├─ user_roles
  ├─ system_config
  └─ 业务集合
```

### 3.2 页面访问数据流

```
用户登录成功
  │
  ├─ AuthGuard 校验登录态
  │
  ├─ PermissionProvider 调用 getUserRole
  │     ├─ 返回 initialized 状态
  │     ├─ 返回当前用户 role
  │     ├─ 返回 pagePermissions
  │     └─ 返回 actionPermissions
  │
  ├─ AppLayout 按 pagePermissions 过滤菜单
  │
  ├─ PermissionGuard 检查当前路由
  │     ├─ 有页面权限：渲染页面
  │     ├─ 无页面权限：跳转 /forbidden
  │     └─ 未初始化且当前用户是 administrator：进入初始化引导
  │
  └─ 页面内按钮按 actionPermissions 控制显示和禁用
```

### 3.3 云函数访问数据流

```
前端调用云函数
  │
  ├─ 云函数读取当前登录用户
  ├─ 查询当前用户角色和功能权限
  ├─ 校验本次操作需要的权限点
  │     ├─ 有权限：继续执行业务逻辑
  │     └─ 无权限：返回 ACCESS_DENIED
  └─ 写操作额外记录操作日志
```

---

## 4. 前端实现方案

### 4.1 新增文件清单

| 文件路径 | 说明 |
|----------|------|
| `src/contexts/PermissionContext.tsx` | 权限上下文，存储初始化状态、当前角色、页面权限和功能权限 |
| `src/hooks/usePermission.ts` | 权限 Hook，封装 `PermissionContext` |
| `src/components/PermissionGuard.tsx` | 路由级权限守卫 |
| `src/pages/Forbidden.tsx` | 禁止访问页面 |
| `src/components/RoleManageTab.tsx` | 设置页-角色管理 Tab |
| `src/components/UserRoleTab.tsx` | 设置页-用户角色分配 Tab |
| `src/components/PermissionBootstrap.tsx` | 权限系统初始化引导 |

### 4.2 修改文件清单

| 文件路径 | 修改内容 |
|----------|----------|
| `src/App.tsx` | 包裹 `PermissionProvider`，新增 `/forbidden`，受保护路由嵌套 `PermissionGuard` |
| `src/components/Layout.tsx` | 根据页面权限过滤 `navItems` |
| `src/pages/Settings.tsx` | 改造为 Tab 页面，新增权限管理相关 Tab |
| 业务页面 | 根据功能权限控制新增、编辑、删除等按钮 |
| `src/lib/cloudbase.ts` | 可统一处理 `ACCESS_DENIED`，提示无权限 |

### 4.3 PermissionContext

```typescript
type PermissionStatus =
  | "loading"
  | "ready"
  | "uninitialized"
  | "unassigned"
  | "forbidden"
  | "error";

interface PermissionContextType {
  status: PermissionStatus;
  initialized: boolean;
  roleId: string | null;
  roleName: string | null;
  pagePermissions: string[];
  actionPermissions: string[];
  errorMessage?: string;
  canAccessPage: (path: string) => boolean;
  can: (actionPermission: string) => boolean;
  refreshPermissions: () => Promise<void>;
}
```

规则：

- `status === "loading"` 时显示加载占位。
- `status === "ready"` 时正常渲染。
- `status === "uninitialized"` 时只允许 CloudBase 内置账号 `administrator` 进入初始化引导。
- `status === "unassigned"` 时显示“请联系管理员分配角色”。
- `status === "error"` 时显示权限加载失败，不展示业务页面。
- `pagePermissions.length === 0` 代表没有页面访问权限。
- `actionPermissions.length === 0` 代表没有功能操作权限。

### 4.4 PermissionGuard

```typescript
function PermissionGuard() {
  const { status, canAccessPage } = usePermission();
  const location = useLocation();

  if (status === "loading") return <PageLoader />;

  if (location.pathname === "/forbidden") {
    return <Outlet />;
  }

  if (status === "uninitialized") {
    return location.pathname === "/settings"
      ? <Outlet />
      : <Navigate to="/settings" replace />;
  }

  if (status !== "ready") {
    return <Navigate to="/forbidden" replace />;
  }

  if (!canAccessPage(location.pathname)) {
    return <Navigate to="/forbidden" replace />;
  }

  return <Outlet />;
}
```

`/settings` 不再永久开放。只有在权限系统未初始化，且当前登录用户是 CloudBase 内置账号 `administrator` 时，才允许进入初始化引导；初始化完成后，访问 `/settings` 也必须拥有 `/settings` 页面权限。

### 4.5 Layout 菜单过滤

```typescript
function filterNavItems(items, pagePermissions) {
  return items
    .map(item => {
      if ("children" in item && item.children) {
        const children = item.children.filter(child => pagePermissions.includes(child.path));
        if (children.length === 0) return null;
        return { ...item, children };
      }

      if ("path" in item && !pagePermissions.includes(item.path)) {
        return null;
      }

      return item;
    })
    .filter(Boolean);
}
```

加载中显示骨架或空导航，不通过“显示全部菜单”解决加载态。

### 4.6 设置页面改造

`Settings.tsx` 改造为 Tab 页面：

- `全部设置`：保留 AI 模型设置、订单序号计数器等现有能力。
- `角色管理`：需要 `settings:role_manage`。
- `用户角色`：需要 `settings:user_role_manage`。
- `初始化引导`：仅权限系统未初始化且当前用户为 CloudBase 内置账号 `administrator` 时显示。

角色管理功能：

- 新建、编辑角色：填写角色名称、描述、页面权限、功能权限。
- 删除角色：必须先检查是否有关联用户。
- 系统内置管理员角色不可删除。
- 如果修改会导致没有任何用户保留 `settings:role_manage` 权限，则拒绝保存。

用户角色分配功能：

- 用户列表来自 `permission_users` 本地集合。
- 设置页提供“从 CloudBase 同步用户”按钮，调用云函数拉取 CloudBase Auth 已注册用户，并按 `userId` merge 到 `permission_users`。
- `user_roles` 只保存角色映射，不作为用户来源。
- 每个用户最多分配一个角色。
- 修改角色后刷新当前用户权限，当前用户失权时立即跳转 `/forbidden`。

---

## 5. 云函数设计

### 5.1 新增云函数

| 云函数 | 说明 |
|--------|------|
| `getUserRole` | 获取当前登录用户的初始化状态、角色、页面权限、功能权限 |
| `manageRoles` | 角色列表、新建、编辑、删除 |
| `manageUserRoles` | 同步 CloudBase 用户、查询本地用户角色列表、分配、移除 |
| `initializePermissionSystem` | 权限系统首次初始化，创建管理员角色和首个管理员映射 |

### 5.2 `getUserRole`

输入不需要传 `userId`，云函数必须从登录上下文读取当前用户，避免前端伪造。

```typescript
type GetUserRoleResponse = {
  success: boolean;
  initialized: boolean;
  status: "ready" | "uninitialized" | "unassigned" | "forbidden" | "error";
  data?: {
    roleId: string;
    roleName: string;
    pagePermissions: string[];
    actionPermissions: string[];
  };
  errMsg?: string;
}
```

逻辑：

1. 读取当前登录用户。
2. 查询 `system_config.permission_system`。
3. 如果系统未初始化，判断当前用户登录名是否为 `administrator`。
4. 未初始化且是 `administrator`，返回 `status: "uninitialized"`。
5. 未初始化但不是 `administrator`，返回 `status: "forbidden"`。
6. 已初始化时，查询 `user_roles`。
7. 未分配角色返回 `status: "unassigned"`。
8. 角色不存在返回 `status: "error"`。
9. 角色存在则返回页面权限和功能权限。

### 5.3 `manageRoles`

```typescript
action: "list"   -> 需要 settings:role_manage
action: "create" -> 需要 settings:role_manage
action: "update" -> 需要 settings:role_manage
action: "delete" -> 需要 settings:role_manage
```

delete 规则：

- 如果角色有关联用户，拒绝删除。
- 如果角色是系统内置管理员角色，拒绝删除。
- 如果删除会导致系统无管理员或无人拥有 `settings:role_manage`，拒绝删除。

update 规则：

- 如果修改的是管理员角色，不能移除最后一个管理员所需的关键权限。
- 如果修改后系统无人拥有 `settings:role_manage` 或 `settings:user_role_manage`，拒绝保存。

### 5.4 `manageUserRoles`

```typescript
action: "syncUsers" -> 需要 settings:user_role_manage，从 CloudBase Auth 拉取已注册用户并 merge 到 permission_users
action: "list"      -> 需要 settings:user_role_manage，读取 permission_users 并合并 user_roles
action: "assign"    -> 需要 settings:user_role_manage
action: "remove"    -> 需要 settings:user_role_manage
```

规则：

- `assign` 需要校验目标 `roleId` 存在，且目标用户已存在于 `permission_users`。
- `remove` 不能移除最后一个管理员的角色。
- 当前用户修改自己的角色时，如果会导致自己失去权限管理能力，必须确认还有其他管理员。
- 所有变更记录操作日志。

### 5.5 `initializePermissionSystem`

仅用于首次初始化。

输入：

```typescript
{
  adminRoleName?: string;
}
```

逻辑：

1. 读取当前登录用户。
2. 查询 `system_config.permission_system`。
3. 如果已初始化，直接拒绝。
4. 如果当前用户不是 CloudBase 内置账号 `administrator`，拒绝。
5. 创建或更新 `role_admin`。
6. 给当前用户写入 `permission_users` 本地用户记录和 `user_roles` 管理员映射。
7. 将 `system_config.permission_system.initialized` 更新为 `true`。
8. 记录初始化日志。

---

## 6. 服务端鉴权设计

### 6.1 通用鉴权方法

云函数应复用统一的鉴权逻辑，例如：

```javascript
async function requirePermission(actionPermission) {
  const currentUser = await getCurrentUserFromContext();
  if (!currentUser) {
    throw createAuthError("LOGIN_REQUIRED", "请先登录");
  }

  const permission = await loadUserPermission(currentUser.uid);
  if (!permission.initialized) {
    throw createAuthError("PERMISSION_UNINITIALIZED", "权限系统未初始化");
  }

  if (!permission.role) {
    throw createAuthError("ACCESS_DENIED", "当前用户未分配角色");
  }

  const actions = permission.role.actionPermissions || [];
  if (!actions.includes("*") && !actions.includes(actionPermission)) {
    throw createAuthError("ACCESS_DENIED", "无权执行该操作");
  }

  return { currentUser, permission };
}
```

### 6.2 云函数权限点示例

| 云函数 | 操作 | 所需权限 |
|--------|------|----------|
| `queryOrders` | 查询订单 | `orders:read` |
| `saveOrders` | 新增订单 | `orders:create` |
| `updateOrder` | 编辑订单 | `orders:update` |
| `deleteOrder` | 删除订单 | `orders:delete` |
| `queryInvoices` | 查询发票 | `invoices:read` |
| `saveInvoice` | 新增发票 | `invoices:create` |
| `updateInvoice` | 编辑发票 | `invoices:update` |
| `deleteInvoice` | 删除发票 | `invoices:delete` |
| `queryCompanies` | 查询公司 | `companies:read` |
| `saveCompany` / `updateCompany` / `deleteCompany` | 写公司信息 | `companies:write` |
| `manageCounter` | 修改序号计数器 | `settings:update` |
| `generateDailyShipmentStats` | 生成日切统计 | 定时任务内部权限，不暴露普通用户调用 |
| `queryDailyShipmentStats` | 查询首页统计 | `stats:read` 或 `/` 页面隐含读取权限 |

### 6.3 错误返回规范

权限错误统一返回：

```json
{
  "success": false,
  "code": "ACCESS_DENIED",
  "errMsg": "无权执行该操作"
}
```

常见错误码：

| code | 说明 |
|------|------|
| `LOGIN_REQUIRED` | 未登录或登录态失效 |
| `PERMISSION_UNINITIALIZED` | 权限系统未初始化 |
| `ACCESS_DENIED` | 无访问或操作权限 |
| `ROLE_UNASSIGNED` | 当前用户未分配角色 |
| `ROLE_NOT_FOUND` | 用户关联的角色不存在 |
| `PERMISSION_LOAD_FAILED` | 权限加载失败 |

前端收到 `ACCESS_DENIED` 后展示无权限提示，不应自动重试或改用更高权限。

---

## 7. 路由与权限集成

### 7.1 App.tsx 路由结构

```tsx
<HashRouter>
  <PermissionProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AuthGuard />}>
        <Route element={<PermissionGuard />}>
          <Route path="/forbidden" element={<AppLayout><Forbidden /></AppLayout>} />
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
      </Route>
    </Routes>
  </PermissionProvider>
</HashRouter>
```

### 7.2 页面访问规则

| 页面 | 是否受权限保护 | 规则 |
|------|:--:|------|
| `/login` | 否 | 登录页无需认证和权限。 |
| `/forbidden` | 是，但永远放行 | 只显示无权限提示，不访问敏感数据。 |
| `/settings` | 是 | 初始化期仅 `administrator` 可进入；初始化后必须拥有 `/settings`。 |
| 其他业务页面 | 是 | 必须拥有对应页面权限。 |

---

## 8. 初始化与防锁死机制

### 8.1 初始化流程

1. CloudBase Auth 中使用内置账号 `administrator` 登录系统。
2. `getUserRole` 返回 `status: "uninitialized"`。
3. 前端进入权限初始化引导。
4. 调用 `initializePermissionSystem`。
5. 云函数创建管理员角色、写入 `administrator` 本地用户记录，并创建当前用户管理员映射。
6. 写入 `initialized: true`。
7. 前端刷新权限，进入正常系统。

### 8.2 防锁死规则

- 禁止删除最后一个管理员用户的角色映射。
- 禁止删除最后一个拥有 `settings:role_manage` 的角色。
- 禁止把最后一个管理员角色的 `settings:role_manage` 或 `settings:user_role_manage` 权限移除。
- 禁止删除 `role_admin` 系统内置角色。
- 如果当前管理员修改自己的角色或权限，保存前必须确认还有其他管理员。
- 如果检测到权限配置异常，云函数拒绝写入并返回明确错误。

---

## 9. 实施计划

### 阶段 1：数据层与云函数

| 步骤 | 内容 |
|------|------|
| 1.1 | 创建 `roles`、`permission_users`、`user_roles`、`system_config` 集合 |
| 1.2 | 为 `permission_users.userId` 和 `user_roles.userId` 建唯一索引 |
| 1.3 | 开发统一鉴权工具函数 |
| 1.4 | 开发 `getUserRole` |
| 1.5 | 开发 `initializePermissionSystem` |
| 1.6 | 开发 `manageRoles` 和 `manageUserRoles` |
| 1.7 | 为订单、发票、公司、设置等敏感云函数补服务端鉴权 |

### 阶段 2：前端权限基础

| 步骤 | 内容 |
|------|------|
| 2.1 | 创建 `PermissionContext` 和 `usePermission` |
| 2.2 | 创建 `PermissionGuard` 和 `Forbidden` 页面 |
| 2.3 | 修改 `App.tsx` 集成权限守卫 |
| 2.4 | 修改 `Layout.tsx` 菜单过滤 |
| 2.5 | 统一处理 `ACCESS_DENIED` 错误提示 |

### 阶段 3：设置页面和权限配置

| 步骤 | 内容 |
|------|------|
| 3.1 | 改造 `Settings.tsx` 为 Tab 页面 |
| 3.2 | 实现初始化引导 |
| 3.3 | 实现角色管理 |
| 3.4 | 实现 CloudBase 用户同步和用户角色分配 |
| 3.5 | 角色或用户权限变更后刷新当前用户权限 |

### 阶段 4：测试与上线

| 步骤 | 内容 |
|------|------|
| 4.1 | 验证 `administrator` 初始化流程 |
| 4.2 | 验证不同角色菜单过滤和路由拦截 |
| 4.3 | 验证按钮权限控制 |
| 4.4 | 直接调用云函数验证无权限会被拒绝 |
| 4.5 | 验证最后一个管理员不可删除或失权 |
| 4.6 | 验证权限加载失败不会放开权限 |

---

## 10. 边界情况与处理策略

| 场景 | 处理策略 |
|------|----------|
| 系统未初始化 | 只允许 `administrator` 进入初始化流程，其他用户显示无权限 |
| 用户未同步到本地列表 | 拒绝访问，提示管理员先从 CloudBase 同步用户 |
| 用户未被分配角色 | 拒绝访问业务页面，提示联系管理员分配角色 |
| 用户关联的角色不存在 | 拒绝访问，提示角色配置异常 |
| 角色权限数组为空 | 按明确无权限处理 |
| 权限云函数调用失败 | 显示权限加载失败，不渲染业务页面 |
| 两个管理员同时编辑同一角色 | 以最后保存为准，但保存前必须重新校验防锁死规则 |
| 删除角色时仍有关联用户 | 拒绝删除，提示先调整关联用户 |
| 当前管理员修改自己的权限 | 保存前检查是否还有其他管理员 |

---

## 11. 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 权限边界 | 前端体验控制 + 云函数服务端鉴权 | 防止绕过前端直接调用云函数 |
| 角色存储位置 | CloudBase 文档数据库 | 与现有数据基础设施一致 |
| 权限粒度 | 页面级 + 功能级 | 同时满足菜单路由控制和只读/编辑等操作控制 |
| 初始化方式 | CloudBase 内置账号 `administrator` | 避免任意登录用户获得权限配置能力，并减少额外配置 |
| `/settings` 访问策略 | 初始化期有限开放，初始化后受权限控制 | 兼顾首次配置和上线后安全 |
| 权限异常策略 | 默认拒绝 | 避免异常时扩大权限 |
| 一个用户能否拥有多个角色 | 暂不支持，一个用户一个角色 | 简化实现，满足当前管理需求 |
| 通配符权限 | 仅管理员角色允许 `*` | 降低普通角色误配置风险 |
