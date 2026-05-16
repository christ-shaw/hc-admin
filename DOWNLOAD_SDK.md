# 云开发 SDK 下载说明

如果 CDN 无法访问，请手动下载 SDK 文件到项目根目录。

## 方法一：直接下载（推荐）

1. 访问以下链接下载 SDK：
   ```
   https://static.cloudbase.net/cloudbase-js-sdk/2.0.0/cloudbase.full.js
   ```

2. 将下载的文件保存为 `cloudbase.js`，放在项目根目录（与 index.html 同级）

3. 修改 `index.html`，将 CDN 引用改为本地引用：
   ```html
   <!-- 将这行 -->
   <script src="https://static.cloudbase.net/cloudbase-js-sdk/2.0.0/cloudbase.full.js"></script>
   
   <!-- 改为 -->
   <script src="cloudbase.js"></script>
   ```

## 方法二：使用 curl 或 wget 下载

在项目目录下执行以下命令之一：

### macOS/Linux (使用 curl)
```bash
curl -o cloudbase.js https://static.cloudbase.net/cloudbase-js-sdk/2.0.0/cloudbase.full.js
```

### macOS/Linux (使用 wget)
```bash
wget -O cloudbase.js https://static.cloudbase.net/cloudbase-js-sdk/2.0.0/cloudbase.full.js
```

### Windows PowerShell
```powershell
Invoke-WebRequest -Uri "https://static.cloudbase.net/cloudbase-js-sdk/2.0.0/cloudbase.full.js" -OutFile "cloudbase.js"
```

## 方法三：使用 npm 安装

如果已安装 Node.js：

1. 在项目目录运行：
```bash
npm install @cloudbase/js-sdk
```

2. 复制文件到项目根目录：
```bash
cp node_modules/@cloudbase/js-sdk/dist/cloudbase.full.js ./cloudbase.js
```

3. 修改 `index.html` 使用本地文件（见方法一）

## 验证下载成功

下载完成后，检查文件大小是否正常（应该几百KB）：

```bash
ls -lh cloudbase.js
```

正常情况下应该看到类似：
```
-rw-r--r-- 1 user staff 500K Feb 21 10:30 cloudbase.js
```

## 如果所有方法都失败

请检查：
1. 网络连接是否正常
2. 防火墙是否阻止了下载
3. 是否使用了代理，需要配置代理设置

也可以尝试其他镜像源：
- 中国国内可能需要配置代理
- 或者使用 GitHub Releases 下载
