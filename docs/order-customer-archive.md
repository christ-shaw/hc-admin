# 新建订单随单建档

新建租赁订单时，客户名称下方及最终确认步骤显示非弹窗提示。具有 `customers:write` 权限、没有已关联客户、未发现相似档案时，默认勾选“保存订单时，同时建立客户档案”。取消勾选后继续保存订单；改变收件信息保留取消选择，改变客户名称重新核对。

名称、收件人、电话、地址用于检查已有客户。存在匹配候选时不默认建档，可直接选择关联已有主档案，也可继续录单后归档。选择档案保留已输入名称和收件信息。查询失败或超时后允许保存订单，提示稍后归档。续租、转租赁及已有客户订单不启用随单建档；非租赁订单沿用当前不关联客户的规则。

`saveOrders` 先提交订单及服务端生成的 `customerArchiveRequested` 标记，然后独立执行建档事务。事务同时创建主档、渠道别名、完整收货档案、订单关联和审计；不完整收件信息不生成空收货档案。建档权限单独检查。任何建档失败都不会将已保存订单报告为失败。

提交前后均检查身份资料，提交事务校验身份版本，避免两个订单并发建立重复客户。订单 ID 是建档幂等键，重试不会重复生成档案。识别出疑似重复时不自动合并，由人工核对。`manageCustomers.createFromOrder` 为已申请的订单提供独立重试，要求 `customers:write` 权限。

列表将本页待补建订单收纳在可展开提示中，支持“重试建档”。标记保存在订单上，刷新页面仍可恢复。手动编辑不能注入建档申请标记。

首次实现仅修改及提交本地代码。启用需要配套更新 `saveOrders`、`manageCustomers` 云函数及前端；订单公共模块通过 `node scripts/sync-customer-order-modules.cjs` 同步，其余订单云函数随下次发布使用同步后的字段过滤规则。

验证：`npm run test:customers`、`npm run build`。可运行 `node scripts/order-archive-preview/server.cjs`，使用本地内存数据验证新客户默认勾选、取消勾选、创建关联及老客户选择，不访问生产数据。

## 2026-09-18 云函数发布

按用户授权，仅更新环境 `cloud1-8gvbotkt966e5e19` 的 `manageCustomers` 和 `saveOrders`。以刚下载的线上代码包为基础，各合入 4 个文件变更；保留线上 package.json 和运行依赖，未发布静态前端。

- `manageCustomers`：变更 `index.js`、`permissions.js`、`orderIngestion.js`，新增 `orderArchive.js`。云端修改时间 `2026-09-18 20:08:30`，Nodejs18.15、60 秒超时。
- `saveOrders`：变更 `index.js`、`customer/orderIngestion.js`，新增 `customer/orderArchive.js`、`customer/records.js`。云端修改时间 `2026-09-18 20:09:09`，Nodejs16.13、20 秒超时。

发布包在隔离副本中通过全部 122 项客户测试。发布后两函数均为 Active / Available，重新下载并核对所有文件：业务代码与运行依赖一致；云端依赖处理只改变了类型声明包及 node_modules 内部锁文件。运行时、超时、内存、环境变量、角色、网络、层及触发器等配置均未变化。

无业务写入的运行检查：`saveOrders` 使用空订单数组正常返回参数校验错误；`manageCustomers.createFromOrder` 使用空订单 ID、无用户身份正常返回 `LOGIN_REQUIRED`，确认新接口已注册且鉴权仍有效。未创建测试业务订单，未补建或批量修改历史客户数据；已保存于旧函数的订单仍需后续核对归档。

备份与回滚代码包：`/private/tmp/hc-order-archive-release-20260918/backup/saveOrders.zip`、`/private/tmp/hc-order-archive-release-20260918/backup/manageCustomers.zip`。发布目录：`/private/tmp/hc-order-archive-release-20260918/release`；文件和配置核验记录：同目录上一级的 `verification.json`。回滚时仅恢复相应备份代码包，保持现有配置。
