# 文件云盘2（cloud2）

不绑卡的大文件云盘，支持 **100MB 以上** 的单文件上传，存储用 **GitHub Releases**。

- 前端：GitHub Pages → https://polytrack114514.github.io/cloud2/
- 后端：Cloudflare Pages Functions（`_worker.js`）→ `https://file-cloud-2.pages.dev`
- 存储：本仓库的 Release（tag `cloud2-data`）

## 为什么能传 100MB 以上

GitHub 仓库 API 单文件上限 100MB，云盘 1 传不了更大的文件。
云盘 2 把文件按 **8MB 一片** 切开，每片上传成一个 release asset，前端并发 2 片、失败重试 3 次。
下载时由后端按顺序拉取分片、流式拼接，并支持 `Range`，所以视频能拖动进度条、大文件能断点续传。

单文件上限约为 **2GB**（GitHub release 单个 asset 的限制），远高于 100MB。

## 功能

- 分片上传（大文件进度、速度、重试、失败自动回滚）
- 文件夹上传（保留相对路径）与新建文件夹
- 目录浏览、面包屑、文件夹改名 / 删除（递归）
- 全局搜索（按文件名 / 路径）
- 排序：名称 / 大小 / 时间，升降序
- 预览：图片、视频、音频、PDF、文本 / Markdown / 代码
- 下载、复制直链、改名、移动
- 写操作需要口令（`UPLOAD_PASSWORD`），读取公开
- 亮 / 暗主题

## 存储结构

| asset 名字 | 含义 |
| --- | --- |
| `p.<路径base64url>.<片号>` | 文件的一个分片（8MB） |
| `p.<路径base64url>.<片号>.0` | 0 字节文件（GitHub 不接受 0 字节 asset，用 1 字节占位并标记） |
| `d.<路径base64url>` | 空文件夹占位 |

文件夹是虚拟的：由文件路径推导出来，只有空文件夹才需要 `d.` 占位。

## 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/list?prefix=` | 列目录 |
| GET | `/file/{key}` | 下载 / 预览，支持 `Range`、`?download=1` |
| GET | `/stats` | 文件总数与总字节数 |
| GET | `/search?q=` | 全局搜索 |
| POST | `/put?key=` | 小文件直传（二进制 body，也支持 0 字节） |
| POST | `/mkdir` | 新建文件夹（`{path}`） |
| POST | `/move` | 文件改名 / 移动（`{from,to}`） |
| POST | `/mvdir` | 文件夹改名 / 移动（`{from,to}`） |
| POST | `/delete` | 删除（`{keys:[...]}`，以 `/` 结尾表示文件夹） |
| POST | `/mp/init` | 初始化分片（`{key,size}`），会清掉同名旧分片 |
| PUT | `/mp/part?key=&uploadId=&n=` | 上传第 n 片（二进制 body） |
| POST | `/mp/complete` | 完成分片（`{key,parts}`） |
| POST | `/mp/abort` | 放弃分片，删除已上传的片 |

除 `GET` 外均需请求头 `X-Password`（或 body 里的 `password`）。

## 部署

1. Cloudflare Pages 新建项目 `file-cloud-2`，把 `worker.js` 作为 `_worker.js` 上传部署。
2. Pages → Settings → 环境变量：
   - `GH_TOKEN`（加密）：对 `cloud2` 有 Contents: Read and write 的 GitHub 令牌
   - `REPO_OWNER` = `polytrack114514`，`REPO_NAME` = `cloud2`，`TAG` = `cloud2-data`
   - `UPLOAD_PASSWORD`（加密）：写操作口令
   - `ALLOW_ORIGIN`：例如 `https://polytrack114514.github.io`
3. 仓库 Settings → Pages → main / 根目录。

## 说明

- 第一次访问接口会在本仓库自动创建 tag 为 `cloud2-data` 的 Release，里面全是 `p.xxx` / `d.xxx` 的 asset；
  **不要手动改动这个 Release**，删掉就等于删文件。
- 直链形如 `https://file-cloud-2.pages.dev/file/目录/文件名`，可直接外链分享。
- 没有回收站，删除即生效。

---

创作者：Shen Xiong · 致谢 AI：TRAE CN（DeepSeek-V4.1-Flash）

© 2026 cloud2.
