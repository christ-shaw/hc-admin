---
name: fix-inventory-tabs-switch
overview: 修复库存管理页面无法切换「半成品库存」「成品库存」「维修仓」Tab 的问题，根因是 TDesign React Tabs 组件属性名用错（tabs → list）。
todos:
  - id: fix-tabs-prop
    content: 将 src/pages/Inventory.tsx 第 307 行的 `tabs=` 改为 `list=`
    status: completed
---

## 问题描述

库存管理页面（Inventory.tsx）中，"半成品库存"、"成品库存"、"维修仓"三个选项卡无法点击切换。

## 根因分析

TDesign React v1.16.9 的 `Tabs` 组件使用 `list` 属性（类型 `Array<TdTabPanelProps>`）来定义选项卡列表，而非 `tabs` 属性。当前代码在第 307 行错误地使用了 `tabs={...}` 传递选项卡配置，导致 TDesign 内部无法识别选项卡列表，因此选项卡渲染为空，无法切换。

## 修复方案

将 `src/pages/Inventory.tsx` 第 307 行的 `tabs={` 改为 `list={`，一行改动即可修复。

## 技术分析

### 组件 API 对照

| 当前使用（错误） | 正确用法 |
| --- | --- |
| `<Tabs tabs={[...]}>` | `<Tabs list={[...]}>` |


`TdTabPanelProps` 支持的字段包括 `value`、`label`、`disabled`、`destroyOnHide`、`lazy`、`panel`、`removable`、`draggable`。当前传入的 `{ value: key, label: `${name} (...)` } `结构与 `TdTabPanelProps` 完全兼容。

`onChange` 回调签名为 `(value: TabValue) => void`，其中 `TabValue = string | number`，当前 `setActiveTab(val as string)` 用法兼容。

### 修改文件

仅修改 `src/pages/Inventory.tsx` 第 307 行：

```
- tabs={Object.entries(tabNameMap).map(([key, name]) => ({
+ list={Object.entries(tabNameMap).map(([key, name]) => ({
```

### 影响范围

- 仅影响库存管理页面的 Tab 组件渲染
- 不涉及其他页面、数据流或云函数
- 无兼容性风险，因为 `list` 是 Tabs 组件的正式 API