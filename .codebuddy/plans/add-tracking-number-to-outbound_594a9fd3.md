---
name: add-tracking-number-to-outbound
overview: 为出库记录添加快递单号（trackingNumber）字段，包括前端类型定义、表格列、筛选、编辑/详情弹窗，以及云函数后端支持
todos:
  - id: update-types
    content: 修改 types/index.ts，OutboundRecord 和 OutboundFilters 添加 trackingNumber 字段
    status: completed
  - id: update-outbound-list
    content: 修改 OutboundList.tsx，表格新增快递单号列，筛选栏新增输入框
    status: completed
    dependencies:
      - update-types
  - id: update-record-edit
    content: 修改 RecordEdit.tsx，出库时也显示快递单号输入框并提交数据
    status: completed
    dependencies:
      - update-types
  - id: update-record-detail
    content: 修改 RecordDetail.tsx，出库详情也显示快递单号
    status: completed
    dependencies:
      - update-types
  - id: update-cloud-functions
    content: 使用 [integration:tcb] 更新云函数支持出库 trackingNumber 字段
    status: completed
    dependencies:
      - update-outbound-list
      - update-record-edit
      - update-record-detail
---

## 用户需求

在出库记录中显示快递单号字段

## 产品概述

当前系统中快递单号（trackingNumber）仅存在于入库记录中，出库记录不支持该字段。需要将快递单号功能扩展到出库记录，包括列表展示、详情查看、编辑修改和筛选查询。

## 核心功能

- 出库记录列表表格中新增"快递单号"列
- 出库记录详情弹窗中显示快递单号
- 出库记录编辑弹窗中支持输入/修改快递单号
- 出库记录筛选栏支持按快递单号搜索
- 后端云函数支持出库记录的 trackingNumber 字段存储和查询

## 技术栈

- 前端：React + TypeScript + TDesign 组件库 + Tailwind CSS
- 后端：CloudBase 云函数
- 数据存储：CloudBase 云数据库

## 实现方案

前端代码本地修改，云函数通过 CloudBase 控制台更新。出库记录的 `trackingNumber` 字段设计为可选字段（`trackingNumber?: string`），与入库记录保持一致，确保已有数据兼容。

## 目录结构

```
src/
├── types/index.ts              # [MODIFY] OutboundRecord 添加 trackingNumber?: string；OutboundFilters 添加 trackingNumber?: string
├── pages/OutboundList.tsx      # [MODIFY] 表格新增快递单号列；筛选栏新增快递单号输入框
├── components/RecordEdit.tsx   # [MODIFY] 出库编辑时也显示快递单号输入框；handleSave 中出库也提交 trackingNumber
├── components/RecordDetail.tsx # [MODIFY] 出库详情也显示快递单号
```

## 实现细节

### 1. types/index.ts

- `OutboundRecord` 接口添加 `trackingNumber?: string`（可选，兼容已有数据）
- `OutboundFilters` 接口添加 `trackingNumber?: string`

### 2. OutboundList.tsx

- `columns` 数组中在"出库日期"列之后插入快递单号列，`cell` 函数中 `row.trackingNumber || '-'`
- 筛选栏 grid 从 `grid-cols-2 md:grid-cols-5` 调整为 `grid-cols-2 md:grid-cols-6`，新增快递单号 Input

### 3. RecordEdit.tsx

- 将快递单号输入框从 `{isInbound && (...)}` 条件中移出，使出库也能显示
- `useEffect` 中初始化 trackingNumber 时去掉 `isInbound` 限制
- `handleSave` 中出库分支也添加 `updateData.trackingNumber = trackingNumber`
- 渠道类型和渠道名称仍保留为入库专属

### 4. RecordDetail.tsx

- 将快递单号显示从 `{isInbound && (...)}` 块中移出，改为独立显示（出库和入库都展示）
- 渠道类型和渠道名称仍保留为入库专属

### 5. 云函数（需在 CloudBase 控制台更新）

- `updateRecord`：出库类型支持 `trackingNumber` 字段更新
- `saveOutbound`：支持接收 `trackingNumber` 参数
- `queryRecords`：出库查询支持 `trackingNumber` 模糊筛选

# Agent Extensions

- **Integration: tcb**：用于更新云函数（updateRecord、saveOutbound、queryRecords）支持出库记录的 trackingNumber 字段