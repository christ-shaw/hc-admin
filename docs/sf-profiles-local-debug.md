# 鸿城 / 汇川并行配置与本地调试

代码支持合入 hc-admin 后在本地运行；启动本地服务不会部署线上 CloudBase。

## 本地模拟调试

要求 Node.js 18.15 或以上；本地页面使用实际云函数代码，内存数据库和模拟顺丰响应。

```sh
npm run dev:sf
```

打开 http://127.0.0.1:5188。此模式无需安装云函数依赖、登录 CloudBase 或配置真实校验码。
可切换管理员/只读用户、鸿城/汇川和沙箱/生产，验证下单、查询、取消、插件参数、超时重试、token 分区和切换审计。
页面中的“生产”同样是模拟；不连接实际 CloudBase 或顺丰。仅监听本机地址，不启用跨域调用。
重启或重置清空模拟数据；如需更换端口，设置 SF_LOCAL_PORT。

建议验收流程：

1. 鸿城下单第一张订单，记住运单所属配置。
2. 管理员切换到汇川，下单第二张订单。
3. 查询、取消或获取第一张订单的插件参数，核对仍使用鸿城。
4. 在新的模拟数据中点击“下一次下单模拟超时”，下单后切换配置，再重试同一订单；确认从原账号恢复同一运单。
5. 切换只读用户，保存按钮不可用；后端同样拒绝配置修改。

模拟数据库不等同于 CloudBase 的事务与索引引擎；真实并发冲突、Windows 打印机以及 PDF 下载仍需沙箱联调。

## 原管理界面

Settings 页面增加鸿城/汇川选择，保存后立即影响新申请；顺丰工作台显示当前新下单配置及每张运单的所属配置。
当前业务构建可执行 `npm run build`。如调试完整管理端，需安装依赖并在 `.env.local` 中配置原项目使用的
`VITE_CLOUDBASE_ENV` 与 Web SDK 的 `VITE_CLOUDBASE_ACCESS_KEY`，再执行 `npm run dev`。
Web SDK 访问标识与顺丰后端校验码是不同字段。顺丰校验码绝不能放进任何 `VITE_*` 变量。
完整管理端默认仍调用其配置的云端函数。双账号版本已于 2026-09-10 部署，汇川沙箱凭据已配置并通过真实 Token 验证，记录见下文。设置页检测后端 `profileRoutingVersion`，旧后端未升级时只读展示并提示，避免误以为切换已经生效。

## 后端配置约定

配置标识为 `hongcheng`（鸿城）、`huichuan`（汇川）。环境仍为 `sandbox` / `production`。
历史订单没有 `sfConfigProfile` 时视为鸿城；新记录明确保存该字段，原 `env` 字段保留。

环境变量按 `SF_<配置>_<环境>_<参数>` 命名：

| 配置 | 沙箱前缀 | 生产前缀 |
| --- | --- | --- |
| 鸿城 | `SF_HONGCHENG_SANDBOX_` | `SF_HONGCHENG_PROD_` |
| 汇川 | `SF_HUICHUAN_SANDBOX_` | `SF_HUICHUAN_PROD_` |

常用参数后缀：

| 后缀 | 配置位置 |
| --- | --- |
| `CLIENT_CODE` | getSfAccessToken、applySfExpress、querySfOrderResult、cancelSfExpress、printSfWaybill、manageSfPluginPrint |
| `CHECK_WORD` | 仅 getSfAccessToken |
| `ACCESS_TOKEN_URL`（可选） | getSfAccessToken |
| `SERVICE_URL`（可选） | 下单、查询、取消、PDF 打印函数 |
| `MONTHLY_CARD` | applySfExpress，寄方月结时必填 |
| `SENDER_MAP_BASE64` 或 `SENDER_CONTACT` / `SENDER_TEL` / `SENDER_ADDRESS` 等 | applySfExpress |
| `PRINT_TEMPLATE_CODE` / `CUSTOM_TEMPLATE_CODE`（可选） | printSfWaybill、manageSfPluginPrint |

示例：`SF_HUICHUAN_PROD_CHECK_WORD`。过渡期鸿城优先使用原来的 `SF_PROD_*` / `SF_PRODUCTION_*` / `SF_SANDBOX_*` 变量，原变量缺失才使用 `SF_HONGCHENG_*`；汇川不回退到鸿城凭据。保留鸿城原凭据不变，以免共用缓存的新旧调用方采用不同账号。
新截图只提供客户编码与校验码，汇川的月结卡号、寄件人和打印模板须按实际账号配置确认，不自动沿用鸿城。
此副本未写入截图中的真实密钥。凭据应通过云函数环境变量配置，不提交到 Git。

## 路由、缓存与上线准备

- `system_config/sf_express` 保存 `activeProfile`、`env`、`revision`，并保存最近 100 条切换审计；管理员并发保存使用版本检查和事务。
- 插件开关按 `pluginPrintEnabledByProfile.<profile>.<env>` 分开，鸿城兼容原开关字段。
- 每次调用固定一次配置，采用 AsyncLocalStorage 保存请求上下文，不修改进程级环境变量。
- 已有运单、处理中或失败重试按记录固定配置；新申请不接受前端自选账号。
- 过渡版 token 缓存：鸿城继续读写原 `sandbox` / `production` 文档；汇川使用 `huichuan:sandbox` / `huichuan:production`。不搬迁、不删除、不双写原缓存。
- 未传 `sfConfigProfile` 的旧 token 调用固定使用鸿城；传了 `sfEnv` 就使用调用方已确定的环境，即使管理员刚刚切换。完全未指定环境的旧调用才按系统环境选择鸿城沙箱/生产。
- 新 token 调用必须同时传入账号与环境。仅传账号而缺少环境会明确失败；汇川不能回退鸿城缓存。
- 尚未部署的上一版 `hongcheng:*` 缓存设计已撤回；若有人已自行部署上一版，不适用本节的旧版兼容假设，需先核对函数版本。
- 原确定性订单记录 ID 保持不变，用于在并发下阻止同一申请被不同账号重复发送。
- 查询、取消和打印依据运单自身的配置与环境，不依赖管理员此时的选择。

共享模块源文件为 `cloud_functions/sfProfile.cjs`；执行 `npm run sf:sync` 同步到各函数包，再部署这些函数的完整目录。
受影响的函数：manageSfConfig、getSfAccessToken、applySfExpress、querySfOrderResult、cancelSfExpress、querySfExpressOrders、manageSfShipment、printSfWaybill、manageSfPluginPrint。
分批部署顺序：

1. 保持当前鸿城配置和接口环境不变，保留全部现有凭据及 token 缓存。
2. 先更新 `getSfAccessToken` 过渡版。旧下单、查询、取消和打印函数仍读原缓存；此时不启用汇川。
3. 更新下单、查询、取消、PDF/插件打印、工作台、包裹管理函数的完整包，确认均包含相同的过渡版 `sfProfile.js`。
4. 最后更新 `manageSfConfig`，再发布设置页。逐项核对全部函数版本、汇川凭据、寄件人、月结和模板配置。
5. 在沙箱完成真实接口及打印联调后，再由管理员选择汇川。混合版本期间保持鸿城及当前接口环境不变。

过渡版可与双配置改造前的旧调用方共存，但不能承诺发布过程零失败。保留原缓存解决的是缓存格式与账号选择兼容问题；部署平台的在途执行及顺丰接口仍需观察。
启用汇川前可回退旧代码，原鸿城缓存仍有效；一旦产生汇川运单，必须保留能按账号处理历史订单的版本，不能把查询/取消/打印全部回退成只认识鸿城的版本。
## 2026-09-10 部署记录

- 发布提交：`34a85a6a6852ae00f552821ea7b06060f37ebb9e`。从该提交独立构建，未发布工作区中尚未提交的客户归档改动。
- 已按顺序更新上述 9 个云函数，均确认 `Active / Available`，无代码加载错误；原环境变量、运行时和超时设置保留。
- 两处前端已发布同一构建：Cloudflare 固定地址 `https://hc-admin-4s3.pages.dev`，CloudBase 地址 `https://cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com`。
- 发布时全局配置保持原有 `production`；未设置 `activeProfile`，按兼容规则使用鸿城。发布操作未切换下单账号、未创建或取消真实运单、未迁移历史数据或 Token 缓存。
- 本地 82 项顺丰测试通过，生产构建通过。云端以 `huichuan / sandbox` 调用 Token 函数，确认账号路由有效，因尚未配置汇川客户编码而失败，没有回退使用鸿城凭据。
- 管理员入口：系统设置 → 顺丰下单配置 → 下单配置（鸿城 / 汇川）及接口环境（沙箱 / 生产）。当前浏览器账号访问设置页被权限校验拒绝，因此未在该账号下执行保存操作；未修改用户权限。
- 汇川沙箱联调前需配置 `SF_HUICHUAN_SANDBOX_CLIENT_CODE`、Token 函数的 `SF_HUICHUAN_SANDBOX_CHECK_WORD` 及下单函数的汇川寄件信息；寄方月结还需该账号月结卡号。打印配置按对应账号核对，不能复制鸿城凭据代替。
- 发布前完整函数 ZIP 与前端入口备份：本机 `/tmp/hc-sf-dual-backup-20260910/`；发布构建：`/tmp/hc-sf-dual-release-20260910/dist/`。这些是临时目录，长期留存需另行归档。

## 2026-09-10 汇川沙箱配置与验证

- 用户随后在设置页选择并保存了 `huichuan / sandbox`，已通过页面及数据库读取确认。
- 已在 getSfAccessToken、applySfExpress、querySfOrderResult、cancelSfExpress、printSfWaybill、manageSfPluginPrint 中新增汇川沙箱客户编码；沙箱校验码只配置在 getSfAccessToken，未写入源码、文档或前端。
- 经用户确认，applySfExpress 的汇川沙箱寄件人映射沿用现有鸿城沙箱映射。保留所有原有鸿城及生产环境变量，未启用汇川生产凭据；本轮未配置汇川月结卡号或专用打印模板。
- 6 个函数均确认配置值生效、状态正常，代码、运行时及超时设置未变。
- 初次真实调用 getSfAccessToken（`sfConfigProfile=huichuan, sfEnv=sandbox`）取得 Token，返回 `cached=false, hasAccessToken=true, expiresIn=7199`；请求 ID：`22c3112f-9dcc-436f-99cb-ea79e75c6a96`。随后发现首次缓存写入未落库，修复与验证见下文；此初次成功返回不足以证明下单可读到缓存。
- 此次完成凭据配置和 Token 验证，尚未实际生成测试运单；寄方月结及打印仍需补齐该账号对应配置后验证。

## 2026-09-10 首次 Token 缓存写入修复

- 问题：不存在的文档执行 `update` 可返回 `stats.updated=0` 而不抛异常，原保存逻辑只在异常分支创建文档，导致获取 Token 报成功，但下单读取 `huichuan:sandbox` 报文档不存在。
- 修复：保留已有缓存更新行为；更新条数为零或文档不存在时，使用 `doc(tokenDocId).set({ data })` 创建固定 ID 的缓存。写入失败正常向调用方返回失败。
- 新增覆盖“零条更新后首次创建并再次命中缓存”和“写入失败不能报告成功”的回归测试；Token 与双账号相关 27 项测试通过。仅部署 getSfAccessToken，保留全部环境变量和超时设置。
- 云端首次调用成功（请求 `c9ac1afb-1b50-4161-9afb-079af67ff9f2`），直接查询数据库确认 `_id=huichuan:sandbox` 已存在，账号和环境正确；第二次调用返回 `cached=true`（请求 `a83a7ec4-111e-408a-a510-ff14702143ae`）。未读取或展示明文 Token，未修改鸿城缓存。
- 修复前函数包备份：本机 `/tmp/hc-getSfAccessToken-before-cache-fix-20260910.zip`。此次未创建或取消运单。

## 2026-09-10 汇川沙箱打印模板配置

- 用户提供并确认基础模板编码 `fm_76130_standard_HCYPDJDQS4NQ`，已在 printSfWaybill 和 manageSfPluginPrint 的 `SF_HUICHUAN_SANDBOX_PRINT_TEMPLATE_CODE` 中配置。两函数均确认 Active / Available，保留所有其他配置及代码，未配置汇川自定义模板。
- 在管理界面使用订单 `1111111`、汇川沙箱运单 `SF7444706453582` 实测“免插件打印”：请求完成，打印弹窗关闭，记录从 0 次变为 1 次，浏览器打开 PDF blob 新标签页。
- 浏览器 URL 安全策略不允许工具读取 blob 预览页，因此面单版式尚未目视验证；未执行实体打印机的最终打印操作。Windows 插件实际打印亦未验证。
- 用户随后确认 PDF 排版正常。
- 用户反馈 Windows 插件入口显示“当前环境未开启”后，已确认 `pluginPrintEnabledByProfile.huichuan.sandbox=true`，汇川生产开关仍为 false，鸿城原开关保留。当前打印弹窗需关闭并重新打开以重新读取配置；Windows 本机插件连接和实际出纸仍待验证。

## 2026-09-10 插件开关回显修复

- 用户反馈设置页点击开关后仍显示关闭。后端保存正常，问题出在 Settings 页面只更新了旧版 `sfPluginEnabledByEnv`，双账号开关却优先读取未更新的 `sfPluginProfiles`。
- 保存成功后同步更新对应账号的开关状态；保存期间禁用两个环境的开关，避免并发保存使回显互相覆盖。保存失败保持原显示值。
- 新增 `npm run test:sf-settings`，验证开启、关闭、切换账号及保存失败的界面状态；2 项测试通过，生产构建通过。前端发布标识：`sf-plugin-switch-state-20260910`。
- 本轮只更新前端，没有修改后台开关。排查时数据库中汇川沙箱和生产开关均已为 true；打印机连接状态仍需在实际 Windows 电脑上验证。

## 2026-09-10 开关实测与汇川月结配置

- 在用户已登录的线上设置页实际执行汇川沙箱插件开启、关闭、再开启；关闭时数据库为 false，恢复开启后数据库为 true。重新打开设置页仍显示开启，生产插件开关保留用户原有状态；接口环境保持汇川沙箱。无需再次部署开关代码。
- 根据用户提供的汇川月结卡号（尾号 9069），在 applySfExpress 配置 `SF_HUICHUAN_SANDBOX_MONTHLY_CARD`。确认函数 Active / Available、配置值匹配，其他环境变量保持原值；完整卡号不写入仓库。
- 本次仅补充当前沙箱联调配置，未配置汇川生产月结卡号；尚未用寄方月结方式实际创建测试运单，月结账号是否通过顺丰校验仍需下单验证。

## 2026-09-10 汇川生产 Client Code

- 用户确认汇川生产 Client Code 与沙箱相同，已在 getSfAccessToken、applySfExpress、querySfOrderResult、cancelSfExpress、printSfWaybill、manageSfPluginPrint 配置 `SF_HUICHUAN_PROD_CLIENT_CODE`，取各函数已有汇川沙箱 Client Code。
- 6 个函数均核验 Active / Available，生产 Client Code 与沙箱一致，其余原有环境变量保持不变。本轮只补充 Client Code；汇川生产校验码、寄件配置、月结卡及打印模板尚未补齐，未执行生产下单。

## 2026-09-10 汇川生产寄件人与月结卡

- 用户明确确认生产环境沿用鸿城生产寄件配置，并使用汇川月结卡（尾号 9069）。已在 applySfExpress 配置 `SF_HUICHUAN_PROD_SENDER_MAP_BASE64` 和 `SF_HUICHUAN_PROD_MONTHLY_CARD`。
- 核验函数 Active / Available、寄件映射与鸿城生产映射一致、月结卡与用户提供值一致，其他环境变量保持不变。未执行真实下单；生产校验码及打印模板仍需配置。

## 2026-09-10 汇川生产校验码验证

- 用户提供生产校验码后，配置 getSfAccessToken 的 `SF_HUICHUAN_PROD_CHECK_WORD`。不在仓库记录明文。
- 生产 Token 请求返回 `auth_error:partner_is_not_exist or secret_is_error`（请求 `ac99698f-5616-4456-ba4c-6f80728494c2`）。此前截图与本次文本第 14 位存在字母 O / 数字 0 差异；按截图核对一次仍返回相同错误（请求 `5ac17cc0-590c-45e5-9099-da047e5b3f4a`），已恢复用户最新提供的文本值，不继续猜测凭据。
- 需从顺丰平台重新确认同一汇川应用的生产客户编码与生产校验码。此次仅测试获取 Token，未创建真实运单。

## 2026-09-10 汇川生产 Token 地址核验

- 经用户明确授权，将 getSfAccessToken 的 `SF_HUICHUAN_PROD_ACCESS_TOKEN_URL` 配置为 `https://sfapi.sf-express.com/oauth2/accessToken`，仅作用于汇川生产账号。核验 Active / Available，其他环境变量原值保留。
- 使用用户再次确认的客户编码和生产校验码强制获取 Token，仍返回 `auth_error:partner_is_not_exist or secret_is_error`（请求 `36e2274f-2dc2-44d3-9005-3d26fcda401f`）。因此切换入口未解决认证问题，不能据此认定原入口是根因；需要在顺丰平台确认该应用生产凭据及开通状态，或由顺丰排查。
- 保留用户授权的新汇川生产 Token 地址，未执行真实下单，未修改鸿城 Token 地址。

## 2026-09-10 汇川生产认证通过

- 用户重新提供生产校验码，和此前值相比第 6、25 位为小写 l，第 14 位为数字 0。按新值更新 `SF_HUICHUAN_PROD_CHECK_WORD`，不含消息末尾的中文句号，不在仓库保存明文。
- 核验 getSfAccessToken Active / Available，其他环境变量保持不变。使用已授权的 sfapi 生产 Token 地址调用成功（请求 `3accaa47-449d-4b3e-a659-7e764d6f4668`），账号 huichuan、环境 production、`cached=false`、有效期 7199 秒。此前认证错误已由新校验码解决；本次未创建真实运单。

## 2026-09-10 汇川生产打印模板

- 用户明确要求生产打印模板与沙箱一致。已将 printSfWaybill（PDF）及 manageSfPluginPrint（Windows 插件）的 `SF_HUICHUAN_PROD_PRINT_TEMPLATE_CODE` 设为各函数汇川沙箱模板 `fm_76130_standard_HCYPDJDQS4NQ`。
- 两函数均核验 Active / Available、生产模板与沙箱一致，其他环境变量保持原值。配置已生效，尚未实际调用生产面单打印。

## 验证命令

```sh
npm run test:sf-profiles
npm run test:sf-settings
npm run test:sf-token
npm run test:sf-print
npm run test:sf-plugin-print
npm run test:sf-data-model
npm run build
```
