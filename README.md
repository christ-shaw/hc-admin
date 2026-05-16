# 出入库记录查询系统

基于腾讯云开发(CloudBase)的手机出入库记录查询Web应用。

## 功能特性

- 📦 展示入库记录列表
- 📤 展示出库记录列表
- 📅 按出入库日期降序排列
- 🔍 点击记录查看详情（包含手机型号、数量、照片等）
- 🖼️ 照片画廊展示，支持点击放大查看
- ☁️ 调用云函数和云存储
- 📱 支持多型号手机记录

## 环境要求

- 腾讯云开发环境ID: `cloud1-8gvbotkt966e5e19`
- 现代浏览器（支持ES6+）

## 项目结构

```
.
├── index.html                    # 主页面
├── app.js                        # 前端逻辑
├── cloud_functions/              # 云函数目录
│   ├── queryInboundRecords/      # 查询入库记录云函数
│   │   ├── index.js
│   │   └── package.json
│   └── queryOutboundRecords/     # 查询出库记录云函数
│       ├── index.js
│       └── package.json
└── README.md
```

## 部署步骤

### 1. 创建云开发环境

在腾讯云控制台创建云开发环境，环境ID为 `cloud1-8gvbotkt966e5e19`。

### 2. 创建数据库集合

在云开发控制台创建以下数据库集合：

- `inbound_records` - 入库记录
- `outbound_records` - 出库记录

### 3. 部署云函数

将 `cloud_functions` 目录下的两个云函数上传到云开发环境：

```bash
# 进入云函数目录
cd cloud_functions/queryInboundRecords
npm install

cd ../queryOutboundRecords
npm install
```

然后在云开发控制台上传这两个云函数。

### 4. 部署前端

将 `index.html` 和 `app.js` 部署到静态托管服务。

### 5. 配置数据库权限

在云开发控制台设置数据库权限，允许所有用户读取：

```
inbound_records: read
outbound_records: read
```

## 数据库字段说明

### 入库记录 (inbound_records)

| 字段 | 类型 | 说明 | 必填 |
|------|------|------|------|
| `_id` | String | 记录唯一标识 | 系统生成 |
| `type` | String | 记录类型，固定为 "inbound" | 是 |
| `supplierName` | String | 供应商名称 | 是 |
| `inboundDate` | String | 入库日期，格式 YYYY-MM-DD | 是 |
| `phoneModels` | Array | 手机型号数组 | 是 |
| `phonePhotos` | Array | 照片URL数组 | 否 |
| `createTime` | Object | 创建时间，MongoDB Date对象 | 系统生成 |
| `updateTime` | Object | 更新时间，MongoDB Date对象 | 系统生成 |

### 出库记录 (outbound_records)

| 字段 | 类型 | 说明 | 必填 |
|------|------|------|------|
| `_id` | String | 记录唯一标识 | 系统生成 |
| `type` | String | 记录类型，固定为 "outbound" | 是 |
| `customerName` | String | 客户名称 | 是 |
| `outboundDate` | String | 出库日期，格式 YYYY-MM-DD | 是 |
| `phoneModels` | Array | 手机型号数组 | 是 |
| `phonePhotos` | Array | 照片URL数组 | 否 |
| `createTime` | Object | 创建时间，MongoDB Date对象 | 系统生成 |
| `updateTime` | Object | 更新时间，MongoDB Date对象 | 系统生成 |

### phoneModels 数组结构

```json
[
  {
    "model": "Xiaomi 13",
    "quantity": 4
  },
  {
    "model": "iPhone 15 Pro",
    "quantity": 1
  }
]
```

## 数据示例

### 入库记录示例

```json
{
  "_id": "28f129fa69991c86013bbb9f68a19c13",
  "type": "inbound",
  "supplierName": "小米官方旗舰店",
  "inboundDate": "2026-02-20",
  "phoneModels": [
    {
      "model": "Xiaomi 13",
      "quantity": 10
    },
    {
      "model": "Xiaomi 14",
      "quantity": 5
    }
  ],
  "phonePhotos": [
    "cloud://cloud1-8gvbotkt966e5e19.636c-cloud1-8gvbotkt966e5e19-1405003451/inbound/phone/小米官方旗舰店_1771641986955_0.jpg"
  ],
  "createTime": {
    "$date": "2026-02-21T02:46:30.654Z"
  },
  "updateTime": {
    "$date": "2026-02-21T02:46:30.654Z"
  }
}
```

### 出库记录示例

```json
{
  "_id": "28f129fa69991c86013bbb9f68a19c13",
  "type": "outbound",
  "customerName": "ada大师傅",
  "outboundDate": "2026-02-20",
  "phoneModels": [
    {
      "model": "Xiaomi 13",
      "quantity": 4
    },
    {
      "model": "iPhone 15 Pro",
      "quantity": 1
    }
  ],
  "phonePhotos": [
    "cloud://cloud1-8gvbotkt966e5e19.636c-cloud1-8gvbotkt966e5e19-1405003451/outbound/phone/ada大师傅_1771641986955_0.jpg"
  ],
  "createTime": {
    "$date": "2026-02-21T02:46:30.654Z"
  },
  "updateTime": {
    "$date": "2026-02-21T02:46:30.654Z"
  }
}
```

## 使用说明

1. 在浏览器中打开 `index.html`
2. 页面会自动加载入库和出库记录
3. 左侧显示入库记录，右侧显示出库记录
4. 每条记录显示：日期、客户/供应商、手机型号、总数量
5. 点击任意记录行可以查看详细信息
6. 详情中包含：所有手机型号明细、照片画廊
7. 点击照片可在新标签页放大查看
8. 点击弹窗外部或关闭按钮可以关闭详情弹窗

## 界面预览

### 列表页
- 左右分栏布局
- 绿色标题：入库记录
- 红色标题：出库记录
- 按日期降序排列

### 详情弹窗
- 记录类型标识（入库/出库）
- 记录ID
- 客户/供应商名称
- 出入库日期
- 创建和更新时间
- 手机型号明细列表
- 照片画廊（网格布局）

## 注意事项

1. 确保云开发环境已正确配置
2. 云函数已部署并正常运行
3. 数据库集合已创建且有正确的权限设置
4. 前端需要能够访问云开发API
5. 照片URL必须使用云存储的完整URL
6. 日期字段支持 MongoDB 的 `$date` 格式和 ISO 字符串格式

## 技术栈

- **前端**：HTML5 + CSS3 + JavaScript (ES6+)
- **SDK**：腾讯云开发 SDK (@cloudbase/js-sdk@1.7.3)
- **后端**：腾讯云云函数 (Node.js)
- **数据库**：腾讯云数据库
- **存储**：腾讯云存储

## 添加测试数据

可以通过云开发控制台手动添加测试数据：

### 添加入库记录

```javascript
db.collection('inbound_records').add({
  data: {
    type: 'inbound',
    supplierName: '小米官方旗舰店',
    inboundDate: '2026-02-21',
    phoneModels: [
      { model: 'Xiaomi 13', quantity: 10 },
      { model: 'Xiaomi 14 Pro', quantity: 5 }
    ],
    phonePhotos: [
      'cloud://cloud1-8gvbotkt966e5e19.xxx/inbound/phone/test_0.jpg'
    ],
    createTime: new Date(),
    updateTime: new Date()
  }
})
```

### 添加出库记录

```javascript
db.collection('outbound_records').add({
  data: {
    type: 'outbound',
    customerName: '测试客户',
    outboundDate: '2026-02-21',
    phoneModels: [
      { model: 'iPhone 15 Pro', quantity: 3 },
      { model: 'iPhone 15', quantity: 2 }
    ],
    phonePhotos: [
      'cloud://cloud1-8gvbotkt966e5e19.xxx/outbound/phone/test_0.jpg'
    ],
    createTime: new Date(),
    updateTime: new Date()
  }
})
```

## 云开发控制台操作

### 上传照片到云存储

1. 进入云开发控制台 > 云存储
2. 点击上传文件
3. 上传照片后复制文件URL
4. 将URL添加到记录的 `phonePhotos` 数组中

### 查看日志

在云开发控制台可以查看：
- 云函数调用日志
- 数据库查询日志
- 云存储访问日志

## 常见问题

### Q: 照片无法显示？
A: 检查云存储权限设置，确保读取权限为"所有用户可读"。

### Q: 列表为空？
A: 确认数据库中有数据，检查云函数是否正常部署。

### Q: 日期排序错误？
A: 确保日期字段格式正确，支持 MongoDB 的 `$date` 格式。

### Q: 如何批量导入数据？
A: 可以在云开发控制台使用数据库导入功能，或编写脚本批量插入。

## 许可证

MIT

---

## 部署信息

**部署时间**: 2026-04-14 21:35

### 访问地址

**前端应用**: https://cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com/?v=202604142135

### 云开发资源

- **环境ID**: cloud1-8gvbotkt966e5e19
- **环境名称**: cloud1
- **环境类型**: 个人版
- **地区**: 上海 (ap-shanghai)
- **状态**: 正常运行

### 已部署服务

1. **静态网站托管**
   - 域名: cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com
   - 存储桶: 37f3-static-cloud1-8gvbotkt966e5e19-1405003451
   - 状态: 已上线
   - 最新更新: 2026-04-02 11:51

2. **云函数**
   - 已部署云函数：
     - queryRecords - 查询记录
     - updateRecord - 更新记录
     - phoneModels - 获取手机型号
     - getShops - 获取店铺列表
     - getRealImageUrl - 获取图片真实URL
     - getOperationLogs - 获取操作日志
     - saveOperationLog - 保存操作日志
     - getRecordHistory - 获取记录历史
     - sendWechatNotification - 企业微信通知

3. **数据库**
   - 实例ID: tnt-fpj1zozis
   - 集合:
     - inbound_records - 入库记录
     - outbound_records - 出库记录
     - operation_logs - 操作日志
     - phone_models - 手机型号库
     - shops - 店铺信息
     - user_whitelist - 用户白名单
     - record_history - 记录修改历史

4. **云存储**
   - 存储桶: 636c-cloud1-8gvbotkt966e5e19-1405003451
   - CDN域名: 636c-cloud1-8gvbotkt966e5e19-1405003451.tcb.qcloud.la

### 控制台入口

- **云开发控制台**: https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/overview
- **数据库管理**: https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/db/doc
- **云函数管理**: https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/scf
- **云存储管理**: https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/storage
- **静态网站管理**: https://tcb.cloud.tencent.com/dev?envId=cloud1-8gvbotkt966e5e19#/static-hosting

### 最新更新日志

**2026-04-02 11:51**
- ✅ 重新部署前端应用到静态托管
- ✅ 上传所有前端文件（index.html, app.js, js模块）
- ✅ 修复统计分析页面数据缺失问题（实现分页查询）
- ✅ 修复日期处理逻辑，支持多种日期格式
- ✅ 删除调试日志，优化性能
- ✅ 添加编辑记录页面增加手机型号功能
- ✅ 修复 Chart.js 图表库加载问题

**2026-03-31 23:46**
- ✅ 初始部署完成
