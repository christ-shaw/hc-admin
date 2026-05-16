---
name: fix-build-and-deploy
overview: 修复 Inventory.tsx 中的 TypeScript 类型转换错误，然后构建项目并部署到云开发静态托管 /hc-admin 目录。
todos:
  - id: fix-ts-error
    content: 修复 src/pages/Inventory.tsx 第 88、90 行 TS2352 错误：`as Record
    status: completed
---

## 用户需求

部署静态网站到云开发静态托管的 `/hc-admin` 子目录。

## 前置问题

`npm run build` 失败，`src/pages/Inventory.tsx` 第 88、90 行存在 TypeScript 编译错误 TS2352：`InventoryItem` 是 interface 无索引签名，无法直接 `as Record<string, unknown>`。

## 修复内容

将第 88、90 行的 `(item as Record<string, unknown>)` 按 TS 编译器建议改为 `(item as unknown as Record<string, unknown>)`，通过 `unknown` 中间类型完成安全转换。

## 部署目标

- 环境：`cloud1-8gvbotkt966e5e19`
- 构建产物：`dist/`
- 云端路径：`/hc-admin/`
- 访问地址：`https://cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com/hc-admin/`

## 技术方案

### 修复 TS 类型错误

**文件**：`src/pages/Inventory.tsx`，第 88、90 行

**问题**：`InventoryItem` 是 interface 类型，无 string 索引签名，不能直接 `as Record<string, unknown>`。

**修复**：通过 `unknown` 中间类型桥接：

```typescript
// Before（编译错误）
(item as Record<string, unknown>)[enKey] = ...

// After（通过 unknown 中转）
(item as unknown as Record<string, unknown>)[enKey] = ...
```

### 构建与部署流程

1. 修复 TS 错误后执行 `npm run build`（`tsc -b && vite build`）
2. 使用 TCB 集成 `uploadFiles` 工具将 `dist/` 目录上传到云端 `/hc-admin/`

## 使用的扩展

### Integration: tcb

- **工具**：`uploadFiles`
- **用途**：将构建产物 `dist/` 上传到云开发静态托管的 `/hc-admin/` 目录
- **预期结果**：文件成功上传，可通过 `https://cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com/hc-admin/` 访问