# 拍机堂本地采集服务

首次使用普通 Edge 专用配置手工登录，之后 Playwright 复用同一配置采集，与日常 Edge 分开。浏览器正常执行查询、日期选择和分页；服务监听这些操作产生的账单 JSON 响应，校验成功后保存。不会复刻签名、绕过滑块或直接重放过期请求。

## 首次登录

在此目录运行：

```sh
npm ci
npm run login
```

需安装 macOS Microsoft Edge。在新打开的专用 Edge 窗口手工输入账号密码、确认平台协议并完成滑块。此阶段直接启动普通浏览器，不连接 Playwright，也不启用远程调试。服务不读取或保存密码。

登录并进入买入账单页后，关闭这个专用窗口（保留日常 Edge 窗口）。若 macOS 仍将专用进程留在后台、终端未继续，请在该终端按 Enter，服务仅结束自己启动的专用浏览器进程。随后 Playwright 重新打开同一专用配置，自动查询昨日账单。查询成功后才显示 `LOGIN_VERIFIED`；仅关闭登录窗口不视为登录成功。若再次出现验证，停止采集并记录需要人工处理。

会话保存在 `.runtime/manual-edge-profile/`，与日常 Edge 配置分离。此前 Chromium 诊断配置不会迁移或覆盖。`.runtime/` 已排除 Git，目录权限为仅当前用户可访问。不要上传、分享或提交此目录。

人工登录和自动采集统一使用 Edge 的系统凭据存储；采集端移除了 Playwright 默认的模拟钥匙串/基础密码存储参数，以便读取普通 Edge 加密保存的 Cookie。

## 无人值守验证

需要登录完成后自动衔接两轮验证，可运行 `node cli.mjs setup --start 2026-10-01 --end 2026-10-24`。

```sh
npm run verify -- --start 2026-10-01 --end 2026-10-24
```

每轮都重新启动浏览器，进行完整分页采集；关闭后再次启动并重跑。两轮条数与全部字段的多重集合摘要一致才报告 `UNATTENDED_VERIFIED`。原站合法重复行会保留，物品退款和服务费退款不会按订单号合并。结果在 `.runtime/verification.json`，通过后数据在 `.runtime/data/`。

默认使用有界面的浏览器，但无需人工点击查询或翻页。`--headless` 可单独测试无窗口模式；不能由有界面模式通过推断无窗口模式也通过。

```sh
npm run collect -- --start 2026-10-14 --end 2026-10-14
npm run verify -- --start 2026-10-14 --end 2026-10-14 --headless
```

不传日期时采集北京时间昨日。一次最多 31 个自然日，不采集当天未完成数据。输出目前是本地 JSON，尚未接入管理后台、CloudBase 或 Excel 导出。

## 每日运行

验证通过后才启动以下前台常驻服务：

```sh
npm run serve
```

北京时间 02:00 后采集昨日，最多约 30 秒调度偏差。首次启动先补最近到期日；之后根据 `.runtime/schedule.json` 连续补采断档日期。首次要从指定日期补采可用 `npm run serve -- --start 2026-10-01`，已有成功进度时按进度继续。

本命令没有安装系统开机任务。需保持服务运行、电脑开机且不休眠；电脑离线时无法按点执行，恢复运行后补采。使用 Ctrl+C 停止。

## 失败处理

- 每页间隔 2 秒，响应必须匹配本次日期、分页和买入账单接口。
- 校验业务码、20 个字段、分页总数和日期范围；未完成的任务不会覆盖已完成数据。
- 普通异常等待 10 秒后从第一页完整重试一次；常驻服务失败后 30 分钟再试。
- 登录失效或返回访问验证时，任务停止并写入 `.runtime/last-error.json`。重新执行 `login` 后再运行采集/常驻服务。本版没有外部消息通知。
- 发现残留锁时只在原进程已不存在的情况下恢复，不会强制终止其他浏览器。
- 不支持多个实例同时使用同一采集配置目录。

## 本地检查

`node diagnose.mjs` 使用临时配置分别检查 Chromium 和 Edge 的公开登录页面加载，结果写入 `.runtime/environment-diagnostic.json`，不提交登录。

`node cli.mjs diagnostic-login` 是独立的 Playwright 登录诊断命令，供人工复现一次登录验证问题，不用于普通首次登录。记录请求路径（无查询参数）、HTTP 状态、网络失败和有限的业务错误码（包括 `Result.VerifyCode` / `Result.VerifyResult`），保存到 `.runtime/login-network-diagnostic.json`；不保存请求正文、请求头、Cookie 或响应正文。不会自动拖动或修改验证码。浏览器窗口关闭后不继续重试。

```sh
npm test
```

测试覆盖北京时间 02:00 与跨月边界、精确请求匹配、同物品独立退款保留、成功空数据、分页变化与字段缺失拒绝。

官方参考：[Playwright 认证会话复用](https://playwright.dev/docs/auth)、[持久化浏览器配置](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。
