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
cloudfunctions/        # 云函数（按类型分层：parsers/ media/ guards/）
docs/                  # 项目文档
```

## 文档
- [视频演示](https://636c-请替换为你的云环境 ID-1413227288.tcb.qcloud.la/demo.MP4?sign=ab8fa685a4c1c38747f9d88b4e3e01e1&t=1779300554)
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

### 在微信开发者工具中运行

1. **下载并安装** [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. **打开项目**：启动开发者工具，点击「导入项目」
   - 项目目录：选择克隆下来的 `miniprogram-2` 文件夹
   - AppID：使用你自己的微信小程序 AppID（如果没有，可在微信公众平台注册获取）
   - 后端服务：选择「微信云开发」
3. **开通云开发**：在开发者工具中点击「云开发」图标，开通云环境，将 `cloudfunctions/` 目录下的云函数上传并部署
4. **配置环境变量**：在云开发控制台中为云函数配置必要的环境变量（参考 `cloudfunctions/quickstartFunctions/ENV.example`）
5. **编译运行**：点击「编译」按钮即可在模拟器中预览小程序

> **注意**：该小程序依赖微信云开发的云函数、云数据库和云存储，本地运行需要开通云环境并部署云函数。
>
> 完整的第三方 API 密钥配置请参考 `cloudfunctions/quickstartFunctions/ENV.example` 文件。
