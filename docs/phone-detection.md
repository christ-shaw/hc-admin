# 入库 / 出库手机图片计数

## 实现范围与当前状态

- 云函数 `recognizeRecordPhones` 从 `inbound_records` / `outbound_records` 的 `phonePhotos` 读取图片，并将检测结果存入同一记录的 `phoneDetection`。
- `services/phone-detector` 提供可独立部署的 YOLO HTTP 服务，返回手机目标框和置信度。云函数从目标框计算数量，不采信上游的文字计数。
- 两端代码已经实现。**尚未部署、配置服务地址和密钥、安装模型权重，也未用仓库实拍照片做准确率验收。** 当前仓库没有小程序源码；小程序保存记录后的调用需按下文接入。现有上传行为不会自动触发识别。
- 不修改 `phoneModels`、库存数、发货状态或异常标记。识别数量只用于核对，`needsReview` 始终为 `true`。

## 数量口径

业务已确认同一记录中每张照片都是不同的手机，因此默认 `mode: 'distinct'`：逐张识别后，将所有照片的手机数量相加为 `totalCount`。只有所有照片都识别成功时才返回总数；任一照片失败时总数为 `null`，保留逐张结果供重试与核对。

同一个云文件 ID 自动去重，避免同一文件被重复提交后重复计数。不同文件 ID 中的同一部手机无法自动跨图去重；若将来出现同批手机多角度拍摄的记录，可显式传 `mode: 'separate'`，此时多张照片仅返回逐张数量，不提供合计。包裹照片 `packagePhotos` 不参与识别。

`difference = totalCount - expectedCount`。人工数量取 `phoneModels[].quantity` 之和；总数或人工数量不可用时，差异为 `null`。接口不会把失败、处理中或过期结果计为零台。空目标框的有效识别结果才是零台。

## 云函数接口

名称：`recognizeRecordPhones`。支持直接参数或 `{ data: 参数 }`。

```js
// 在图片上传成功、phonePhotos 写入记录成功之后执行。
// 不要把此调用的失败当成入库/发货保存失败，否则重试保存可能产生重复记录。
const { result } = await wx.cloud.callFunction({
  name: 'recognizeRecordPhones',
  data: {
    type: 'inbound', // 或 outbound，与数据库集合对应，不是渠道类型
    recordId: savedRecordId,
    action: 'recognize',
    mode: 'distinct', // 默认值；每张照片都是不同手机，逐张数量相加
    force: false,
  },
});
if (!result.success) {
  // 展示 result.errMsg；可稍后单独重试识别，不重新保存库存记录。
} else {
  // 必须查看 result.data.status；success=true 表示任务结果已保存，
  // 不代表每一张照片都识别成功。
  const { status, images, totalCount, difference, needsReview } = result.data;
}
```

网页端可通过已有 `callFunction('recognizeRecordPhones', 参数)` 调用。

查看状态（不启动检测、不依赖检测服务配置）：

```js
const { result } = await wx.cloud.callFunction({
  name: 'recognizeRecordPhones',
  data: { type: 'outbound', recordId: savedRecordId, action: 'get' },
});
```

识别权限：`inbound:update` / `outbound:update`；查看权限：对应 `:read`。小程序还必须有 `miniapp:access`。身份来自平台可信 OPENID 或服务端登录态，客户端传入的 `currentUser` 无效。

返回的 `data` 为 `null` 表示尚未识别，否则包含：

| 字段 | 含义 |
| --- | --- |
| `status` | `processing` / `succeeded` / `partial` / `failed` / `stale` |
| `images` | 每张图片的 `fileID`、`status`、`count`、`model`、`detections`；失败含 `code` / `errMsg` |
| `detections[].box` | `[x1, y1, x2, y2]`，左上到右下，相对图像宽高归一化到 0–1 |
| `detections[].confidence` | 0–1 的目标置信度 |
| `totalCount` | 可安全按所选口径合计时为整数，否则 `null` |
| `expectedCount` / `difference` | 人工登记数量 / 与识别数量的差异 |
| `stale` | 照片已变更时为 `true`，此时不得使用旧结果确认数量 |
| `needsReview` | 始终为 `true`，待人工核对 |
| `startedAt` / `completedAt` | ISO 时间 |
| `leaseUntil` | 正在处理时的租约到期时间（毫秒） |

同一照片和口径的成功结果会复用；`force: true` 可重跑。升级模型、调整阈值、覆盖同一个云文件内容后需要强制重跑，因此上传时应使用唯一云文件路径。部分失败重试会重新处理整组照片。

并发调用返回 `RECOGNITION_BUSY`；小程序网络超时后先查询状态，不重新提交入库或发货。处理时间预算 100 秒，云函数超时 120 秒。异常中断后，150 秒租约到期即可重试；不会自动后台重试。读取状态时也会检查照片是否变更。

## 部署检测服务

云函数不直接加载模型。将 `services/phone-detector` 容器部署到能提供 HTTPS 的推理服务器 / 云托管，并配置以下服务器环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `PHONE_DETECTOR_TOKEN` | 至少 32 字符随机密钥，云函数和检测服务一致 |
| `PHONE_DETECTOR_WEIGHTS` | 容器内权重路径，默认 `/models/phone.pt`；必须挂载或打包真实权重文件 |
| `PHONE_DETECTOR_MODEL_VERSION` | 用于结果追溯的版本，默认 `phone-v1`；升级权重时更新 |
| `PHONE_DETECTOR_LABELS` | 手机类别名称，逗号分隔；默认 `cell phone,phone,smartphone,手机` |

```sh
docker build -t hc-phone-detector services/phone-detector
# 在服务平台注入环境变量、挂载权重，并将 HTTPS /detect 转发至容器 8080。
# 不要将密钥写进 Dockerfile、前端 VITE_* 配置或代码仓库。
```

支持 Ultralytics 目标检测权重，包括含 `cell phone` 类别的通用模型与仓库实拍数据训练的自定义模型。模型文件必须由部署者明确准备，容器启动不自动下载权重。Ultralytics 的 `boxes.xyxyn` 提供归一化目标框，`boxes.conf` 提供分数，见[官方推理结果文档](https://docs.ultralytics.com/modes/predict/)。该实现以目标框计数，并非视觉语言模型猜数。

部署前需按选定模型与软件的许可证完成使用评估，相关说明见 [Ultralytics 官方许可说明](https://www.ultralytics.com/license)。密集排列、遮挡、侧边、包装盒图案等场景必须使用真实仓库样本验证，不能仅凭通用模型推断准确率。

## 配置云函数

`cloudbaserc.json` 已声明此函数（120 秒，512MB），仅部署这一函数即可，不需要发布网页或其他云函数。在云端配置：

| 环境变量 | 用途 |
| --- | --- |
| `PHONE_DETECTOR_URL` | 完整 HTTPS 地址，例如 `https://your-detector.example/detect` |
| `PHONE_DETECTOR_TOKEN` | 与检测服务一致的服务端密钥 |
| `PHONE_DETECTOR_THRESHOLD` | 检测阈值，默认 `0.45`，有效范围 `(0, 1]` |

检测服务契约为 `POST` JSON：

```json
{ "imageBase64": "图片二进制的 base64", "threshold": 0.45 }
```

请求头 `Authorization: Bearer <服务端密钥>`。返回 HTTP 200：

```json
{
  "model": "warehouse-phone-v1",
  "detections": [
    { "label": "phone", "confidence": 0.93, "box": [0.1, 0.2, 0.3, 0.7] }
  ]
}
```

可用同契约的其他目标检测服务替换 YOLO。云函数只读取记录中已保存的云文件 ID，不接受客户端任意外部图片 URL；最多 9 张不同照片、单张 10MB。检测容器支持 JPEG/PNG/WebP，限制图片像素和请求体大小。照片只在请求中处理，不由检测容器保存。

## 验证

```sh
npm run test:phone-detection
```

自动化测试覆盖计数、手机类别过滤、置信度过滤、重复框、照片去重、多图口径、缓存、并发、过期租约、照片变更、权限拒绝、部分失败和失败不计零。测试中的检测器为替身，不代表真实模型准确率，也不能替代云端鉴权和网络联调。

上线验收还需：真实入库/出库照片各一组、同批多角度照片、密集排列与遮挡、无手机照片；核对目标框、数量和人工登记差异，再决定是否需要训练仓库专用模型。
