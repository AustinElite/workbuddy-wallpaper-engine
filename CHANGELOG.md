# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-13

首个正式版本。

### 新增

- **壁纸引擎**：扫描本机文件夹，把视频 / 图片 / GIF 作为 WorkBuddy 的动态背景
  （视频用 `<video>` 循环播放，图片用 `<img>`，垫在应用根节点之下）
- **液态玻璃界面**：把 WorkBuddy 的 `--cb-*` 设计变量接到壁纸上，
  面板半透明 + `backdrop-filter` 模糊，透明度 0–60% 可调
- **界面内选择器**：右下角「壁纸」按钮，可选壁纸、调玻璃 / 亮度 / 饱和度、
  切 6 套配色、切适配方式（覆盖 / 完整 / 拉伸）、开关省电
- **设置页**：作为右侧面板里的一个标签页打开（就地复用当前标签，不新开标签），
  内容注入到面板的内容容器中，与原生页面一致
- **开机自启**：写入环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT`、
  把调试参数写进 WorkBuddy 快捷方式、在「启动」文件夹放隐藏启动器
- **监督进程**：`scripts/watchdog.mjs` 常驻，每 15 秒确认守护进程，掉了自动补起来
- **双通道通信**：`Runtime.addBinding` 直达通道（即时响应）+ 队列轮询兜底
- **宿主在线检测**：引擎每轮写心跳，界面据此提示「处理中…」/「引擎未运行」
- **跨平台 CLI**：`status` / `list` / `set` / `clear` / `folder-add` / `schemes` 等
- **技能化安装**：`install-skill.bat` 可把它装进 `~/.workbuddy-ai/skills/`

### 说明

- 零运行时依赖，纯 Node 标准库
- 绝不修改 `app.asar` 或安装目录，只注入活动渲染进程
- 核心版不含 Scene 场景壁纸 WebGL 渲染、ffmpeg 转码、视频倍速 / 翻转
