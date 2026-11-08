# 客户建模阶段 1：实现与验证说明

> 2026-09-05：本地实现完成。尚未部署云函数/前端，也未读取或回填生产数据。

> 本文保留阶段 1 完成时的记录；匹配、事务、请求 ID 与结构初始化的现行约定见[阶段 2 说明](./customer-modeling-phase2.md)。

## 1. 本阶段交付

- 补齐客户统计、合并状态与映射、归档候选、关系及关系候选、合并事件和审计类型；既有订单关联字段保持可选。
- `manageCustomers/permissions.js` 明确每个 action 的权限。阶段 2 之后的动作仅保留权限定义，授权后仍返回 `ACTION_NOT_IMPLEMENTED`；`ingestOrder` 等内部动作在阶段 1 对客户端一律关闭，不能通过 `internal=true` 开启。
- 客户页要求独立 `/customers` 页面权限与客户读取/维护/合并权限；移除 `/orders` 回退。角色配置新增 `customers:merge`，初始化管理员继续使用 `*`，不修改存量订单角色授权。
- 订单表单使用远程 `search` 与受限详情，提供搜索结果、别名和收件档案分页；客户管理列表也补齐分页。查询失败明确提示并可重试。
- 移除前端 `touchRecipient` 调用并关闭该客户端入口，防止任意调用或重复编辑虚增次数。已有 `useCount` 保留，本阶段不保证其准确；按订单维护/重建计数在后续阶段完成。
- 新建/修改客户资料写入标准化版本；搜索和同客户别名去重从原始字段计算，旧版本字段未回填时仍可使用。

## 2. 标准化契约

规则版本：`customer-identity-v2`。

| 字段 | 固定规则 | 边界示例 |
| --- | --- | --- |
| 主名称、别名、收件人 | NFKC → 小写 → 空白、`-`、`_`、`·`、`•`、`.`、`。`、U+2010～U+2015 横线统一为一个空格 → 去首尾空格 | `Ａ—Ｂ` → `a b`；`A B` 与 `AB` 不相同 |
| 电话标准化 | NFKC 后只保留 ASCII 数字；不剥离国家码 | `+86 138-0013-8000` → `8613800138000`，与不含 `86` 的号码保持不同 |
| 完整电话判定 | 首版仅支持 `1[3-9]` 开头的 11 位大陆手机号及带 `86`/`+86` 的形式；允许空白、圆括号和横线，不接受掩码、字母、分机或其他未支持格式 | 不完整或未支持电话仍可保存展示，但不能用于自动关联 |
| 地址 | NFKC → 小写 → 删除空白、逗号、中文句号、分号、冒号、顿号；保留横线、斜杠、括号及门牌文字数字 | `1-203室` 与 `1203室` 不相同 |
| 指纹 | 以 JSON 数组序列化版本、名称、收件人、电话、地址，使用 SHA-256 | 全空观察值返回 `null`；不完整观察值可生成归档指纹，但完整性判定返回 false |

别名渠道作为来源及同客户逻辑去重维度，不新增为自动关联条件。后续统计金额沿用 `getOrderTotalAmount` 的多货品/旧扁平订单口径。

这些函数仅提供标准化、完整性判定及指纹，阶段 1 没有开启任何订单自动匹配或历史归档。

## 3. 查询接口

沿用 `manageCustomers` 已有参数包装方式。以下为业务 payload 示例：

```json
{ "action": "search", "keyword": "客户名称或电话", "page": 1, "pageSize": 20 }
```

- 权限：客户读取能力，或 `orders:create` / `orders:update`；`orders:read` 不足以调用。
- 非空关键词，最长 200 字符；默认 20 条、最多 50 条。
- 只返回启用、未合并客户的 `_id` 和 `displayName`，外层包含 `total`、`page`、`pageSize`。

```json
{ "action": "get", "scope": "orderSelection", "customerId": "客户ID", "aliasPage": 1, "recipientPage": 1, "pageSize": 20 }
```

- 权限同搜索；不能选择停用/合并客户。
- 仅返回客户 ID、显示名，启用别名的 ID/名称/渠道，启用收件档案的 ID/标签/收件人/电话/地址，以及双方页码、总数和每页条数。
- 默认 20 条、最多 50 条，两个档案列表分别分页；不读取订单集合。
- 不返回客户备注、统计、操作记录、关系或历史订单；即使调用人是管理员也使用相同字段白名单。
- 不带 scope 的完整 `get`、管理 `list` 要求客户读取能力；管理 `list` 默认 20 条、最多 100 条。

返回代码包括 `LOGIN_REQUIRED`、`ACCESS_DENIED`、`ACTION_NOT_ALLOWED`、`ACTION_NOT_IMPLEMENTED`、`CUSTOMER_UNAVAILABLE`、`KEYWORD_REQUIRED`。底层异常返回通用错误并仅记录 action 和错误码，避免输出身份信息。

## 4. 旧标准化字段回填

脚本：`scripts/backfill-customer-normalization.cjs`。默认只读预览，必须显式提供环境或本地数据文件；本次仅测试了本地合成数据。

本地预览输入是按集合名组织的 JSON 对象，含 `customers`、`customer_aliases`、`customer_recipient_profiles` 三个数组。

```sh
npm run customers:normalization-backfill -- --input /absolute/path/customer-fixture.json --output /absolute/path/preview.json
```

准备在目标环境执行时，使用已登录且具备相应数据库权限的 CloudBase CLI：

```sh
npm run customers:normalization-backfill -- --env TARGET_ENV_ID --output /absolute/path/preview.json
npm run customers:normalization-backfill -- --env TARGET_ENV_ID --apply --confirm TARGET_ENV_ID --output /absolute/path/applied.json
```

执行步骤：

1. 先完成数据库备份，再运行 dry-run，核对扫描数、需修改字段和同客户同渠道的别名冲突 ID。
2. 报告仅保存记录 ID、变更字段名及计数，不记录完整姓名、电话、地址或标准化值。根据冲突 ID 在客户管理中检查，不由脚本合并或停用别名。
3. 确认报告后运行写入命令；仅更新三个客户集合的 `normalized*` 和 `normalizationVersion`，不访问 `orders`，不更新原始字段或业务审计时间。
4. 每批读取最多 100 条，使用 `_id` 游标。每条更新比较原始字段和旧派生字段，防止覆盖期间发生的编辑；写后重新查询核验。
5. 并发冲突记录为 `conflict_retry_required`，退出码为 2。中断或冲突后可从头重跑，已经符合当前规则的记录自动跳过。
6. 写入后再次 dry-run，确认变更数归零；如仍有别名冲突，交由授权维护人员处理。此脚本不生成客户归档候选、不改变任何订单归属。

此回填工具与后续 `scanUnlinkedOrders` 不同：后者才处理订单观察值和归档候选。

## 5. 验证与后续边界

- `npm run test:customers`：22 项测试通过，覆盖标准化、指纹、匿名及角色权限、字段白名单、分页、异步失败、历史字段兼容、资料维护、前端权限/查询 hook 和回填幂等及并发冲突。
- `npm run build`：TypeScript 与 Vite 生产构建通过；存在打包产物超过 500 kB 的提示，不影响构建成功。
- `git diff --check`：通过。

尚未进行真实 CloudBase 环境联调。客户列表/搜索本阶段在服务端聚合筛选后分页返回；索引查询优化仍按阶段 6 实施。合并映射解析、订单引用合法性校验、可信内部调用、统一身份匹配及订单补偿仍按阶段 2～4 实施。

发布时必须将 `normalizers.js` 和 `permissions.js` 随 `manageCustomers` 一起打包，云函数先于前端发布；权限收紧后，旧版已打开的订单页需刷新以使用受限查询。生产验证使用固定地址 `https://hc-admin-4s3.pages.dev`。
