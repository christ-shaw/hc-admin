---
name: fix-permission-denied
overview: 升级 CloudBase SDK 到 v2 并实现透明匿名登录，解决 PERMISSION_DENIED 错误
todos:
  - id: upgrade-sdk
    content: 升级 @cloudbase/js-sdk 到 v2 并安装依赖
    status: completed
  - id: modify-cloudbase
    content: 修改 cloudbase.ts：ensureInit 中自动匿名登录
    status: completed
    dependencies:
      - upgrade-sdk
  - id: cleanup-dead-code
    content: 删除 useAuth.ts 和 AuthGuard.tsx 废弃文件
    status: completed
    dependencies:
      - modify-cloudbase
---

## 产品概述

移除登录页面后，应用调用云函数报错 `PERMISSION_DENIED: Unauthenticated access is denied`。需要在无登录页面的前提下，让 CloudBase SDK 在初始化时自动匿名登录，使云函数调用获得认证身份，对用户完全透明。

## 核心功能

- 升级 `@cloudbase/js-sdk` 从 v1.x 到 v2.x（v1.x 匿名登录 API 不兼容）
- 在 `cloudbase.ts` 的 `ensureInit` 中初始化 SDK 后自动执行匿名登录
- 清理已废弃的 `useAuth.ts`、`AuthGuard.tsx`（不再被任何活跃代码引用）
- 前置条件：用户需在 CloudBase 控制台开启匿名登录

## 技术栈

- CloudBase JS SDK v2（`@cloudbase/js-sdk@^2.0.0`）
- 匿名登录 API：`app.auth({ persistence: 'local' }).anonymousAuthProvider().signIn()`

## 实现方案

在 `callFunction` 调用前自动完成「初始化 SDK + 匿名登录」，对业务层完全透明：

1. **升级 SDK**：`@cloudbase/js-sdk` 从 `^1.7.3` 升级到 `^2.0.0`
2. **改造 `ensureInit`**：初始化 SDK 后自动调用 `auth.anonymousAuthProvider().signIn()`，若已有登录状态则跳过
3. **清理废弃文件**：删除 `useAuth.ts` 和 `AuthGuard.tsx`（它们引用了 `cloudbase.ts` 中已不存在的函数）

## 关键修改

### `src/lib/cloudbase.ts` [MODIFY]

`ensureInit` 增加：初始化后检查登录状态，未登录则自动匿名登录

```
app = cloudbase.init({ env: ENV_ID })
const auth = app.auth({ persistence: 'local' })
const loginState = await auth.getLoginState()
if (!loginState) {
  await auth.anonymousAuthProvider().signIn()
}
```

### `package.json` [MODIFY]

`@cloudbase/js-sdk` 版本从 `^1.7.3` 改为 `^2.0.0`

### `src/hooks/useAuth.ts` [DELETE]

引用了 `cloudbase.ts` 中已删除的函数（`signInWithEmail`, `signUpWithEmail`, `signInAnonymously`, `signOut`, `initCloudBase`, `getLoginState`），且不再被任何活跃组件使用

### `src/components/AuthGuard.tsx` [DELETE]

引用 `useAuth`，不再被 `App.tsx` 使用

## 注意事项

- 用户必须在 CloudBase 控制台开启匿名登录：https://tcb.cloud.tencent.com/dev#/identity/login-manage
- `persistence: 'local'` 确保匿名登录状态持久化，刷新页面无需重新登录
- 匿名登录失败时 `callFunction` 应返回有意义的错误提示，不阻塞页面渲染