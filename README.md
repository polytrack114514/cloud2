# 文件云盘2（cloud2）

基于 **Cloudflare R2** 的大文件云盘，支持 **100MB 以上**、乃至数 GB 的单文件上传。

- 前端：GitHub Pages → https://polytrack114514.github.io/cloud2/
- 后端：Cloudflare Pages Functions（`_worker.js`）→ `https://file-cloud-2.pages.dev`
- 存储：Cloudflare R2 桶（绑定变量名 `BUCKET`）

## 为什么能传 100MB 以上

GitHub 仓库 API 单文件上限 100MB，所以云盘 1 传不了更大的文件。
云盘 2 把文件存进 R2，并且前端按 **8MB 一片** 切片、并发 2 片、失败自动重试 3 次，
后端用 R2 的 **Multipart Upload** 拼接。浏览器不会一次性把整个文件塞进一个请求，
因此单文件大小只受 R2 配额限制，与 Workers 的 100MB 请求体上限无关。

## 功能

- 分片上传（大文件进度、速度、重试、失败自动 abort）
- 文件夹上传（保留相对路径）
- 目录浏览、面包屑、新建文件夹、文件夹改名 / 删除（递归）
- 全局搜索（按文件名 / 路径）
- 排序：名称 / 大小 / 时间，升降序
- 预览：图片、视频、音频、PDF、文本 / Markdown / 代码
- 下载、复制直链、改名、移动
- 写操作需要口令（`UPLOAD_PASSWORD`），读取公开
- 亮 / 暗主题

## 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/list?prefix=` | 列目录（`delimiter:/`） |
| GET | `/file/{key}` | 下载 / 预览，支持 `Range`、`?download=1` |
| GET | `/stats` | 文件总数与总字节数 |
| GET | `/search?q=` | 全局搜索 |
| POST | `/put?key=` | 小文件直传（二进制 body） |
| POST | `/mkdir` | 新建文件夹（`{path}`） |
| POST | `/move` | 文件改名 / 移动（`{from,to}`） |
| POST | `/mvdir` | 文件夹改名 / 移动（`{from,to}`） |
| POST | `/delete` | 删除（`{keys:[...]}`，以 `/` 结尾表示文件夹） |
| POST | `/mp/init` | 初始化分片（`{key,size,type}`）→ `{uploadId}` |
| PUT | `/mp/part?key=&uploadId=&n=` | 上传第 n 片（二进制 body）→ `{partNumber,etag}` |
| POST | `/mp/complete` | 完成分片（`{key,uploadId,parts}`） |
| POST | `/mp/abort` | 放弃分片 |

除 `GET` 外均需请求头 `X-Password`（或 body 里的 `password`）。

## 部署

1. Cloudflare 后台 **开启 R2**（需要在 Dashboard 里点启用，可能要求绑定支付方式；免费额度 10GB 存储 / 月）。
2. 创建 R2 桶，例如 `cloud2`。
3. 创建 Pages 项目 `file-cloud-2`，把本目录的 `worker.js` 作为 `_worker.js` 上传部署。
4. Pages 项目 → Settings：
   - 绑定 `BUCKET` → 选择 R2 桶
   - 环境变量 `UPLOAD_PASSWORD`（加密）、`ALLOW_ORIGIN`（如 `https://polytrack114514.github.io`）
5. 仓库 Settings → Pages → 分支 `main` / 根目录，得到 `https://polytrack114514.github.io/cloud2/`。

## 说明

- 单个分片最小 5MiB（R2 限制），本前端用 8MiB，安全。
- 文件删除立即生效，没有回收站（R2 无版本时无法恢复）。
- 直链形如 `https://file-cloud-2.pages.dev/file/目录/文件名`，可直接外链分享。

---

创作者：Shen Xiong · 致谢 AI：TRAE CN（DeepSeek-V4.1-Flash）

© 2026 cloud2.
