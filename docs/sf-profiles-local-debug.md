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
完整管理端默认仍调用其配置的云端函数；本轮未部署云函数，所以双配置完整联调应在后端版本准备完成后进行。设置页检测后端 `profileRoutingVersion`，旧后端未升级时只读展示并提示，避免误以为切换已经生效。

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

示例：`SF_HUICHUAN_PROD_CHECK_WORD`。鸿城兼容原来的 `SF_PROD_*` / `SF_SANDBOX_*` 变量；汇川不回退到鸿城凭据。
新截图只提供客户编码与校验码，汇川的月结卡号、寄件人和打印模板须按实际账号配置确认，不自动沿用鸿城。
此副本未写入截图中的真实密钥。凭据应通过云函数环境变量配置，不提交到 Git。

## 路由、缓存与上线准备

- `system_config/sf_express` 保存 `activeProfile`、`env`、`revision`，并保存最近 100 条切换审计；管理员并发保存使用版本检查和事务。
- 插件开关按 `pluginPrintEnabledByProfile.<profile>.<env>` 分开，鸿城兼容原开关字段。
- 每次调用固定一次配置，采用 AsyncLocalStorage 保存请求上下文，不修改进程级环境变量。
- 已有运单、处理中或失败重试按记录固定配置；新申请不接受前端自选账号。
- token 缓存 ID 为 `hongcheng:sandbox` 等四个分区。旧的 `sandbox/production` 缓存不再读取，也不删除。
- 原确定性订单记录 ID 保持不变，用于在并发下阻止同一申请被不同账号重复发送。
- 查询、取消和打印依据运单自身的配置与环境，不依赖管理员此时的选择。

共享模块源文件为 `cloud_functions/sfProfile.cjs`；执行 `npm run sf:sync` 同步到各函数包，再部署这些函数的完整目录。
受影响的函数：manageSfConfig、getSfAccessToken、applySfExpress、querySfOrderResult、cancelSfExpress、querySfExpressOrders、manageSfShipment、printSfWaybill、manageSfPluginPrint。
正式部署需协调所有调用方与 token 函数版本，避免新旧 token 缓存协议混用；不支持只更新 token 函数就立刻切换汇川。
本地已完成模拟验证，尚未切换或部署线上配置。

## 验证命令

```sh
npm run test:sf-profiles
npm run test:sf-token
npm run test:sf-print
npm run test:sf-plugin-print
npm run test:sf-data-model
npm run build
```
