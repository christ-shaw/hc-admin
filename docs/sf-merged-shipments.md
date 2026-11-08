# 顺丰合并出单与已打印面单追加

## 操作流程

- 勾选 2–20 条未生成过单号、未打印的顺丰待发货订单，点击「合并出单」。已取消的历史运单也不能重新加入新合并。
- 弹窗展示每条订单的收件人、电话、地址和收费方式，必须主动选择一组。该订单作为主单，也沿用其人员的寄件配置。
- 全部货品汇总为一个包裹，只申请一个顺丰单号、打印一张面单。原始订单的收件资料不变，统一回填单号和共享关系。
- 已打印、尚未交接的主顺丰单显示「追加订单」。按日期或完整网店订单号查询，勾选 1–20 条未发货且无有效运单的订单，确认使用原面单收件信息后追加。
- 追加不调用顺丰创建接口，不要求先「开放追加」。原纸质面单备注不会随追加更新，需要更新备注时重新打印。
- 包裹回到打包中，清除原包裹照片。全部关联订单均生成出库单并完成出库后才能确认交接；已交接、已揽收、已取消或历史锁定运单不可追加。

## 接口与一致性

- `applySfExpress` 新增 `mergeOrderIds` 和 `recipientChoice`，`sourceOrderId` 必须属于所选订单。服务端复核用户确认的四项资料，并校验历史出单和打印记录。
- 调用顺丰前，通过事务占用订单和已有出库记录。单独申请也参与占用，避免和合并或追加请求重复出单。
- 顺丰申请失败或超时后，成员关联保留。使用主单的「查询」或「重试」恢复；查询成功会同时回填所有成员。
- `manageSfShipment.listAppendOrders` 接收 `sfExpressOrderId`、`date` 和可选的 `onlineOrderNumber`。日期查询最多检查 100 条，返回 `truncated` 提示精确查询。
- `manageSfShipment.appendOrders` 接收 `sourceOrderIds`、`shipmentVersion`、`requestId` 和 `confirmShipmentRecipient: true`。版本冲突拒绝写入，相同请求重试幂等；一次事务更新全部成员、备注、出库记录和操作历史。
- 订单可在出单或追加之后再生成出库单，`generateOutboundFromOrders` 会补上运单关联和包裹版本。
- 旧的开放追加、匹配复用接口保留兼容。

## 发布与验证

需一起发布前端及以下云函数：`applySfExpress`、`querySfExpressOrders`、`querySfOrderResult`、`manageSfShipment`、`generateOutboundFromOrders`。

`applySfExpress` 新增 `permissionAuth.js` 和 `@cloudbase/node-sdk` 依赖，部署需安装云端依赖。无需迁移现有数据或更改顺丰账号配置。

本地验证：`npm run build`、`npm run test:sf-data-model`、`npm run test:sf-profiles`、`npm run test:sf-plugin-print`、`npm run test:sf-print`。新增场景位于 `scripts/sf-local/shipments.test.cjs`，使用模拟接口，不创建真实运单。
