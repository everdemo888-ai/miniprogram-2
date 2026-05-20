# 项目技术栈

## 前端

| 层 | 技术 |
|---|------|
| 框架 | 微信小程序原生（WXML + WXSS + JS） |
| 基础库 | 2.33.0+（隐私协议需 ≥2.32.3，分享视频需 ≥2.11.0） |
| 自定义 TabBar | `custom-tab-bar` 组件，SVG 图标 |
| 激励视频 | `wx.createRewardedVideoAd` |
| 媒体选择 | `wx.chooseMedia`、`wx.chooseMessageFile` |
| 视频压缩 | `wx.compressVideo`（品质 / 高级参数双模式） |
| 文件下载 | `wx.downloadFile` + `DownloadTask.onProgressUpdate` |
| 持久化 | `wx.getFileSystemManager().saveFile` |
| 相册保存 | `wx.saveVideoToPhotosAlbum` |
| 网络 | `wx.cloud.callFunction`（所有后端通信） |

## 后端（微信云开发）

| 层 | 技术 |
|---|------|
| 运行时 | Node.js 18.15，云函数单实例 256MB |
| 超时 | 300 秒 |
| 数据库 | 微信云数据库（`video_jobs`、`users`、`orders`、`usage_records`、`checkins` 五张集合） |
| 存储 | 微信云存储（解析后视频上传，前端 `getTempFileURL` 获取临时链接） |

### 云函数模块

| 模块 | 职责 | 关键依赖 |
|------|------|---------|
| `parsers/videoExtract.js` | 多平台视频链接解析 + HLS 下载合并 | `axios` |
| `media/asrTencent.js` | 腾讯云 ASR TC3 签名与 API 调用 | `crypto`、`axios` |
| `media/asrRecTask.js` | 录音文件识别异步任务提交与轮询 | — |
| `media/tencentCiTranscode.js` | COS 数据万象媒体转码 | `cos-nodejs-sdk-v5` |
| `media/ciCompressTask.js` | 云端压缩任务提交与轮询 | — |
| `guards/bizGuard.js` | 频控、广告积分、安全日志 | — |

## 第三方服务

| 服务 | 用途 | 配置方式 |
|------|------|---------|
| BugPK | 多平台视频链接解析（主） | 环境变量可选覆盖 |
| 龟龟呀 | 抖音解析备选 | `GUIGUIYA_API_KEY` |
| HelloTik | 聚合解析备选 | `HELLOTIK_API_TOKEN` |
| devtool.top | 抖音解析内置线路 | `VIDEO_PARSE_DOUYIN_URL` 可覆盖 |
| TenAPI | 抖音解析备用 | `TENAPI_VIDEO_URL` 可覆盖 |
| api.tjit.net | 快手解析内置线路 | `VIDEO_PARSE_KUAISHOU_KEY` |
| 腾讯云 ASR | 语音转文字 | `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` |
| 腾讯云 COS 数据万象 | 视频云端转码压缩 | 同上，加 Bucket/Region/TemplateId |

## 配置文件

| 文件 | 用途 |
|------|------|
| `config.js` | 集中管理超时、截断长度、上传限制、平台 Referer、业务常量 |
| `messages.js` | 集中管理所有用户可见的中英文提示/错误消息 |
| `ENV.example` | 云函数环境变量模板 |
| `jobLabels.js` | 任务类型与状态的中文映射（前端） |
| `cloudUtils.js` | `ensureCloudEnv` / `callCloud` 封装（前端） |
