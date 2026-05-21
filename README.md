# xiaobaitu — 短视频去水印小程序

粘贴抖音、快手、小红书、B站等平台分享链接，一键解析无水印视频，支持预览、下载到相册、复制直链。附带视频压缩、文案提取、MD5 变更等工具。

> **GitHub 仓库**：https://github.com/everdemo888-ai/miniprogram-2.git
>
> 欢迎克隆、Star、提交 Issue 或贡献代码。

## MVP 功能点

| 功能 | 说明 | 亮点 |
|------|------|------|
| 多平台解析 | 粘贴分享链接 → 自动识别平台 → 解析无水印直链 | 5 平台、12+ 端点 fallback |
| 视频预览 | 解析完成后立即在页面内播放 | 即时播放，不等下载 |
| 保存到相册 | 下载到本地 → 一键存入手机相册 | 后台下载复用、实时进度条 |
| 视频压缩 | 本机压缩（3 档品质 + 高级参数） | 长视频自动识别并推荐省流 |
| 提取文案 | 音视频上传 → 腾讯云 ASR 转文字 | 支持长音频 |
| MD5 变更 | 上传视频 → 生成 MD5 不同的副本 | 末尾追加 free 原子，不破坏编码 |
| 历史记录 | 查看/重试/删除过往任务 | 一键重试失败任务 |
| 积分体系 | 签到 + 激励广告 → 积分 → 跳过广告 | 完整免费使用闭环 |

## 项目结构

```
miniprogram/           # 小程序前端
cloudfunctions/        # 云函数
docs/                  # 项目文档
```

### 重要代码文件说明

#### 小程序前端 `miniprogram/`

| 文件 | 说明 |
|------|------|
| `app.js` | 应用入口，云环境初始化，全局数据 `globalData` |
| `app.json` | 页面路由、窗口样式、自定义 TabBar 配置 |
| `pages/index/index.*` | 首页 — 粘贴链接一键解析、本地上传、压缩/提取文案/MD5 变更 |
| `pages/history/history.*` | 历史记录 — 查看/重试/删除过往任务，双 Tab 切换（任务记录 / 使用记录） |
| `pages/mine/mine.*` | 我的 — 用户信息、积分签到、激励广告、FAQ |
| `pages/guide/guide.*` | 引导页 — 新用户功能指引 |
| `custom-tab-bar/index.*` | 自定义底部导航栏（首页 / 我的） |
| `utils/cloudUtils.js` | 云函数调用封装（`callCloud`） |
| `utils/rewardAdGate.js` | 激励广告门控 — 看广告赚积分 / 消耗积分跳过广告 |
| `utils/jobLabels.js` | 任务类型名称和状态文案映射 |
| `utils/cloudErrorText.js` | 用户可见的错误提示文案 |

#### 云函数 `cloudfunctions/quickstartFunctions/`

| 文件 | 说明 |
|------|------|
| `index.js` | 云函数入口 — 路由分发（11 个 action），任务状态流转（queued → processing → completed/failed），调用 parser / media / guard 完成实际处理 |
| `config.js` | 全局常量 — 超时时间、上传限制、平台 Referer、业务参数 |
| `messages.js` | 所有用户可见提示和错误消息的集中管理 |
| `parsers/videoExtract.js` | 多平台视频解析 — 从抖音/快手/小红书/B站/视频号分享链接提取无水印直链，内置 BugPK/龟龟呀/HelloTik 等多线路 fallback |
| `guards/bizGuard.js` | 业务防护 — 提交频控、广告奖励日上限、日志脱敏 |
| `media/asrRecTask.js` | 语音识别调度 — 提交腾讯云 ASR 录音文件识别任务并轮询结果 |
| `media/asrTencent.js` | 腾讯云 ASR API 封装（CreateRecTask / DescribeTaskStatus） |
| `media/ciCompressTask.js` | 视频压缩调度 — 提交 COS 数据万象转码任务并轮询结果 |
| `media/tencentCiTranscode.js` | 腾讯云 COS 数据万象 API 封装（CreateMediaJobs / DescribeMediaJob） |

#### 配置文件

| 文件 | 说明 |
|------|------|
| `cloudbaserc.json` | CloudBase 部署配置 |
| `project.config.json` | 微信开发者工具项目配置（AppID、云开发根目录等） |
| `cloudfunctions/quickstartFunctions/ENV.example` | 云函数环境变量完整说明 |

## 文档
- [视频演示](https://636c-cloud1-2gjjfajt727732cc-1413227288.tcb.qcloud.la/demo.MP4?sign=ab8fa685a4c1c38747f9d88b4e3e01e1&t=1779300554)
  点击下载视频观看演示
- [项目描述](docs/STAR.md)

- [缺陷与展望](docs/ROADMAP.md)
- [技术栈](docs/TECH_STACK.md)
- [报错排查](docs/DEBUG.md)
- [AI 协作记录](docs/AI_COLLABORATION.md)

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/everdemo888-ai/miniprogram-2.git

# 进入项目目录
cd miniprogram-2
```

### 环境准备

- [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（最新稳定版）
- 一个微信小程序 AppID（可在 [微信公众平台](https://mp.weixin.qq.com/) 注册获取）

### 在微信开发者工具中运行

#### 第 1 步：导入项目

打开微信开发者工具，点击「导入项目」：

- **项目目录**：选择克隆下来的 `miniprogram-2` 文件夹
- **AppID**：填写你的微信小程序 AppID
- **后端服务**：选择「微信云开发」

> 如果 `project.config.json` 中的 `appid` 显示为占位符，请替换为你自己的 AppID。

#### 第 2 步：开通云环境

1. 在开发者工具顶部点击「云开发」图标
2. 点击「开通」，创建一个云环境（如果已有环境可跳过）
3. 创建完成后，记下**环境 ID**（后续配置需要用到）

#### 第 3 步：初始化云函数

```bash
# 安装云函数依赖
cd cloudfunctions/quickstartFunctions
npm install
cd ../..
```

然后在微信开发者工具中：

1. 展开 `cloudfunctions/` 目录
2. 右键 `quickstartFunctions` → 点击「上传并部署：云端安装依赖」（等待上传完成）
3. 右键 `cloudfunctions/` 根目录 → 点击「上传所有云函数」

#### 第 4 步：创建数据库集合

在云开发控制台 → 「数据库」中，手动创建以下 5 个集合（无需设置索引，代码会自动创建）：

| 集合名 | 说明 |
|--------|------|
| `video_jobs` | 视频任务记录 |
| `users` | 用户信息 |
| `orders` | 订单记录 |
| `usage_records` | 使用记录 |
| `checkins` | 签到记录 |

#### 第 5 步：配置最少环境变量

在云开发控制台 → 「云函数」→ 点击 `quickstartFunctions` → 「配置」→ 「环境变量」，**只需添加以下 1 个变量即可体验核心功能**（无需任何第三方 API Key）：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TCB_ENV_ID` | 你的微信云开发环境 ID | `your-env-id-123abc` |

> 🔑 **注意**：变量名在代码中为 `TCB_ENV_ID`，与云函数 `cloud.init` 的调用一致，不是 `CLOUD_ENV_ID`。

其他可选变量（按需配置，不配也能跑，但免费接口不稳定）：

- 商用解析接口：`VIDEO_PARSE_URL` / `VIDEO_PARSE_JSON_PATH`（推荐生产环境使用）
- 龟龟呀 API Key：`GUIGUIYA_API_KEY`（免费，适合快速体验）
- HelloTik Token：`HELLOTIK_API_TOKEN`
- 腾讯云语音识别：`TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`

完整变量说明见 [`cloudfunctions/quickstartFunctions/ENV.example`](cloudfunctions/quickstartFunctions/ENV.example)

#### 第 6 步：修改前端云环境配置

打开 **`miniprogram/app.js`**（项目根目录下的 `miniprogram/` 文件夹内），将 `globalData.env` 改为你的云环境 ID（与第 5 步中的 `TCB_ENV_ID` 值相同）：

```js
globalData: {
  env: 'your-env-id-123abc',  // ← 替换为你的云环境 ID（与 TCB_ENV_ID 保持一致）
}
```

#### 第 7 步：编译运行

点击开发者工具中的「编译」按钮，即可在模拟器中预览小程序。

---

### 验证是否成功

- ✅ 首页能正常加载，不报云环境未初始化错误
- ✅ 粘贴一个抖音/快手分享链接，点击「一键提取」，能正常提交任务
- ✅ 历史记录页面能正常显示任务列表

---

> **注意**：未配置第三方 API Key 时，免费解析接口可能不稳定或限流。生产环境建议配置商用解析接口。
>
> 完整的第三方 API 密钥配置请参考 [`cloudfunctions/quickstartFunctions/ENV.example`](cloudfunctions/quickstartFunctions/ENV.example)。
