---
name: cloudbase-react-fullstack-deploy
overview: 使用 CloudBase React 模板创建全栈应用，包含前端 React 项目、云函数后端、数据库和云存储，并部署到 CloudBase。
design:
  architecture:
    framework: react
    component: tdesign
  styleKeywords:
    - Glassmorphism
    - Dark Sidebar
    - Card Layout
    - Gradient Accents
    - Micro-animations
  fontSystem:
    fontFamily: PingFang-SC
    heading:
      size: 24px
      weight: 600
    subheading:
      size: 16px
      weight: 500
    body:
      size: 14px
      weight: 400
  colorSystem:
    primary:
      - "#0052D9"
      - "#266FE8"
      - "#4787F0"
    background:
      - "#F3F4F6"
      - "#FFFFFF"
      - "#1B2838"
    text:
      - "#1F2937"
      - "#6B7280"
      - "#FFFFFF"
    functional:
      - "#00A870"
      - "#E34D59"
      - "#ED7B2F"
      - "#0052D9"
todos:
  - id: init-project
    content: 初始化 React + TypeScript + Vite 项目，安装 TDesign、Tailwind CSS、@cloudbase/js-sdk 等依赖
    status: pending
  - id: cloudbase-init
    content: 配置 cloudbaserc.json，使用 [integration:tcb] 查询环境信息并初始化 CloudBase SDK
    status: pending
    dependencies:
      - init-project
  - id: build-frontend
    content: 开发前端应用：布局组件、首页仪表盘、数据管理页、文件管理页
    status: pending
    dependencies:
      - cloudbase-init
  - id: build-functions
    content: 开发云函数 API，封装数据库操作和业务逻辑
    status: pending
    dependencies:
      - cloudbase-init
  - id: init-database
    content: 使用 [integration:tcb] 创建数据库集合并配置安全规则
    status: pending
    dependencies:
      - build-functions
  - id: deploy-all
    content: 使用 [integration:tcb] 部署云函数、构建前端并部署到静态托管，验证应用可访问
    status: pending
    dependencies:
      - build-frontend
      - init-database
---

## 产品概述

在腾讯云 CloudBase 上创建并部署一个 React 全栈应用，包含前端界面、云函数后端 API、云数据库和云存储能力。

## 核心功能

- **React 前端应用**：基于 React + TypeScript 构建的 Web 管理后台，通过 @cloudbase/js-sdk 与后端通信
- **云函数后端 API**：Serverless 云函数提供 RESTful API，处理业务逻辑（增删改查等）
- **云数据库**：文档型数据库存储业务数据，支持集合创建、安全规则配置
- **云存储**：文件上传/下载/管理，支持图片等资源文件的云端存储
- **静态托管部署**：前端构建产物部署到 CloudBase 静态网站托管服务

## 技术栈

- **前端框架**：React 18 + TypeScript + Vite
- **UI 组件库**：TDesign React（企业级设计系统，与 CloudBase 生态一致）
- **样式方案**：Tailwind CSS
- **CloudBase SDK**：@cloudbase/js-sdk（Web 端 SDK）
- **后端运行时**：CloudBase 云函数（Node.js）
- **数据库**：CloudBase 文档数据库
- **存储**：CloudBase 云存储
- **部署工具**：CloudBase CLI / tcb 集成

## 实现方案

使用 CloudBase CLI 初始化项目结构，创建 React 前端 + 云函数后端的全栈应用。前端通过 @cloudbase/js-sdk 直连云数据库和云存储，复杂业务逻辑通过云函数处理。最终通过 CloudBase 静态托管部署前端，云函数单独部署。

### 关键技术决策

1. **Vite 而非 CRA**：Vite 构建速度更快，开发体验更好，是 React 社区当前推荐方案
2. **@cloudbase/js-sdk 直连数据库**：对于简单的 CRUD 操作，前端可通过 SDK 直连数据库，减少云函数数量
3. **云函数处理复杂逻辑**：涉及权限校验、数据聚合、跨集合操作等场景使用云函数
4. **TDesign 组件库**：企业级组件库，与 CloudBase 生态风格一致，适合管理后台场景

## 实施注意事项

- 云函数部署包大小限制 50MB，需控制依赖体积
- 数据库安全规则必须配置，避免未授权访问
- 云存储需配置 CORS 和访问权限
- 前端构建产物需配置 `cloudbaserc.json` 中的托管路径

## 架构设计

```mermaid
graph TB
    subgraph Frontend[React 前端 - 静态托管]
        UI[React App + TDesign]
        SDK[@cloudbase/js-sdk]
    end
    
    subgraph Backend[CloudBase 后端服务]
        CF[云函数 API]
        DB[云数据库]
        ST[云存储]
    end
    
    UI --> SDK
    SDK -->|直连 CRUD| DB
    SDK -->|文件上传下载| ST
    SDK -->|复杂逻辑| CF
    CF -->|服务端操作| DB
    CF -->|服务端操作| ST
```

## 目录结构

```
/Users/zhibinxiao/CodeBuddy/hc-admin/
├── cloudbaserc.json          # [NEW] CloudBase 项目配置文件，定义云函数、托管等资源配置
├── package.json              # [NEW] 根目录 package.json，包含工作区配置和部署脚本
├── .env                      # [NEW] 环境变量文件，存储 CloudBase 环境 ID
├── .gitignore                # [NEW] Git 忽略配置
├── src/                      # 前端源码目录
│   ├── App.tsx               # [NEW] 应用根组件，包含路由和布局
│   ├── main.tsx              # [NEW] 应用入口文件
│   ├── vite-env.d.ts         # [NEW] Vite 类型声明
│   ├── index.html            # [NEW] HTML 入口模板
│   ├── cloudbase.ts          # [NEW] CloudBase SDK 初始化和封装，统一管理 SDK 实例
│   ├── styles/
│   │   └── index.css         # [NEW] 全局样式和 Tailwind 入口
│   ├── pages/
│   │   ├── Home.tsx          # [NEW] 首页/仪表盘页面，展示数据概览
│   │   ├── DataManage.tsx    # [NEW] 数据管理页面，演示数据库 CRUD 操作
│   │   └── FileManage.tsx    # [NEW] 文件管理页面，演示云存储上传下载
│   ├── components/
│   │   └── Layout.tsx        # [NEW] 应用布局组件，包含侧边栏和顶栏
│   └── hooks/
│       ├── useDatabase.ts    # [NEW] 数据库操作 Hook，封装集合的增删改查
│       └── useStorage.ts    # [NEW] 云存储操作 Hook，封装文件上传下载
├── functions/                # 云函数目录
│   └── api/
│       ├── index.js          # [NEW] API 云函数入口，处理业务逻辑请求
│       └── package.json      # [NEW] 云函数依赖声明
├── tsconfig.json             # [NEW] TypeScript 配置
├── tsconfig.node.json        # [NEW] Node 端 TypeScript 配置
├── vite.config.ts            # [NEW] Vite 构建配置
├── tailwind.config.js        # [NEW] Tailwind CSS 配置
└── postcss.config.js         # [NEW] PostCSS 配置
```

## 设计风格

采用 Glassmorphism + 现代企业管理后台风格，深色侧边栏搭配浅色内容区，卡片式布局配合微动画，打造高端管理后台体验。

## 页面规划

### 页面1：首页/仪表盘

- **顶部导航栏**：Logo + 应用名称 + 用户头像，半透明毛玻璃效果
- **侧边栏导航**：深色渐变背景，图标+文字导航项，当前项高亮发光效果
- **数据概览区**：4 张统计卡片，悬浮阴影+渐变边框，展示关键业务指标
- **最近活动区**：时间线列表，展示最近数据变更记录
- **快捷操作区**：操作按钮组，一键跳转到常用功能

### 页面2：数据管理

- **筛选栏**：搜索框 + 筛选条件，支持实时搜索
- **数据表格**：TDesign Table 组件，斑马纹 + 悬浮高亮，支持排序分页
- **操作列**：编辑/删除按钮，行内操作
- **新增弹窗**：TDesign Dialog 表单，添加/编辑数据记录
- **批量操作栏**：选中后底部浮出批量操作工具条

### 页面3：文件管理

- **上传区域**：拖拽上传区，虚线边框 + 拖入高亮，支持多文件
- **文件列表**：网格/列表视图切换，缩略图预览，文件信息展示
- **预览弹窗**：图片大图预览，支持缩放旋转
- **操作工具栏**：下载/删除/复制链接操作

### 页面4：设置页

- **环境信息卡片**：展示当前 CloudBase 环境 ID、域名等信息
- **数据库管理**：集合列表，安全规则查看
- **存储配置**：CORS 规则、访问权限配置

## 集成

- **tcb (CloudBase)**
- Purpose: 使用 CloudBase MCP 工具进行环境查询、数据库集合创建、云函数部署、静态托管部署等操作
- Expected outcome: 完成全栈应用的云端资源初始化和部署，包括数据库集合创建、云函数部署、前端静态托管部署