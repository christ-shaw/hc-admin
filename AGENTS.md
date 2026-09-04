# Project instructions

## Deployment URLs

- Cloudflare Pages 的固定生产地址是 `https://hc-admin-4s3.pages.dev`。
- 向用户提供或打开 Cloudflare 线上版本时，只使用上述固定生产地址。
- Wrangler 返回的 `https://<deployment-id>.hc-admin-4s3.pages.dev` 是一次性部署地址，不得作为用户访问地址。该地址不在 CloudBase 安全域名白名单中，会导致 Web SDK 请求失败并显示 `network request error`。
- CloudBase 静态托管地址是 `https://cloud1-8gvbotkt966e5e19-1405003451.tcloudbaseapp.com`。
