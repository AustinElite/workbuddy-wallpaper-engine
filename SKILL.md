---
name: workbuddy-wallpaper-engine
description: >-
  Turn local video/image wallpapers into the WorkBuddy desktop app's animated
  background with an iOS-style liquid-glass UI, via local CDP injection. Use when
  the user wants a video wallpaper / dynamic background / live wallpaper for
  WorkBuddy, asks to "把视频当壁纸", "给 WorkBuddy 换动态壁纸", "壁纸引擎",
  "wallpaper engine for WorkBuddy", or wants to manage (add folder / switch /
  remove) their WorkBuddy wallpapers. Never modifies app.asar or the install dir.
---

# WorkBuddy Wallpaper Engine

把本机的视频/图片壁纸铺到 WorkBuddy 桌面端界面后方，配 iOS 液态玻璃效果。
灵感来自 DSH 插件 `elysia395/dsh-wallpaper-engine`，按 WorkBuddy 的 CDP 注入
体系重新实现。

## 它做什么

- **壁纸发现**：扫描用户配置的文件夹（默认 `~/.workbuddy-wallpaper-engine/wallpapers`），
  识别 `.mp4 / .webm / .mov / .m4v / .ogv / .mkv / .gif / .png / .jpg / .jpeg / .webp / .avif / .bmp`
- **渲染**：视频用真实 `<video>` 图层循环播放，图片/GIF 用 `<img>`，垫在 `#root` 之下
- **液态玻璃**：把 WorkBuddy 的 `--cb-*` 设计变量接到壁纸上，面板半透明 + `backdrop-filter` 模糊，
  透明度 0–60% 可调
- **界面内选择器**：WorkBuddy 右下角出现「壁纸」按钮，点开可选壁纸、调玻璃透明度/亮度/饱和度、
  切 6 套配色、切适配方式、开关省电
- **省电**：窗口失焦/最小化时暂停视频，电池供电时暂停（可关）
- **持久化**：全部设置存宿主端 `~/.workbuddy-wallpaper-engine/config.json`，
  重启、换端口都不丢

## 前置条件

- WorkBuddy 桌面端已安装
- Node.js 18+（注入器是纯 Node，跨平台）
- 用户本机需有壁纸文件；本插件**不依赖 Wallpaper Engine / Steam**

## 开机自启（推荐：一次设置，之后打开 WorkBuddy 就有壁纸）

```powershell
.\install-autostart.bat
```

它做三件事：

1. **写用户级环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT=9223`。**
   WorkBuddy 官方支持这个变量——启动时会自己 `appendSwitch('remote-debugging-port')`
   并顺带加上 `remote-allow-origins`。**但注意：环境变量只对「环境块刷新之后」启动的进程生效**——
   explorer.exe 拿着旧环境块时，从它启动的 WorkBuddy 读不到新值，通常得注销一次。
2. **把调试参数写进 WorkBuddy 的快捷方式**（桌面 + 开始菜单里的 `WorkBuddy AI.lnk`）。
   只改 TargetPath 指向 `WorkBuddyAI.exe` 的快捷方式，其它跳过。
   **快捷方式的启动参数是立刻生效的**，所以这一步把「必须注销一次」这个坑填掉了。
3. **在「启动」文件夹放一个隐藏启动器**（`WorkBuddyWallpaperEngine.vbs`），
   登录时静默拉起**监督进程**（`scripts/watchdog.mjs`）。

**为什么是监督进程而不是直接起守护进程**：启动项只在**登录时**跑一次。
如果用户只是重启 WorkBuddy（没有注销），登录项不会触发；此时若守护进程因为任何
原因已经不在，就没人去注入，表现为「重启后没有壁纸」。监督进程常驻，每 15 秒确认
一次守护进程，掉了就补起来——于是只要它活着，「重启 WorkBuddy 一定有壁纸」。

安装时会**立刻把监督进程拉起来**，所以不需要注销/重启就能生效。

### 「重启 WorkBuddy 还是没壁纸」的两个经典原因

按这个顺序查（`node scripts/autostart.mjs status` 一眼能看出来）：

| 现象 | 原因 | 处理 |
|---|---|---|
| `CDP 未就绪` | WorkBuddy 不是带调试端口启动的 | 从**桌面/开始菜单快捷方式**重开 WorkBuddy（参数已写进快捷方式）；或用别的方式启动过，则注销一次 |
| `监督进程 未运行` | 登录项还没触发过（只重启了 WorkBuddy，没注销） | 双击 `install-autostart.bat` |
| `守护进程 未运行`、监督在跑 | 刚被拉起来 | 等 15 秒再看 |
| 都正常但界面没壁纸 | 注入被 React 重渲染冲掉 | 看 `engine.log` 尾部有无异常 |

之后打开 WorkBuddy，壁纸自动出现，不用再跑任何脚本。

> 装完需要**重启一次 WorkBuddy**：当前这个实例是用「没有该变量」的环境启动的，
> 读不到新值。这一步会关掉 WorkBuddy，先提醒用户保存。

取消自启（并还原原生外观）：`.\uninstall-autostart.bat`

查状态：`node scripts/autostart.mjs status`

## 手动启动（临时用，不装自启）

1. 确认 WorkBuddy 已带调试端口运行。若没有，用一键脚本重启（会关闭 WorkBuddy，先提醒用户保存）：

   ```powershell
   .\apply-wallpaper.bat
   ```

   等价于：

   ```bash
   node scripts/start-detached.mjs                # 需要时重启 WorkBuddy 并拉起守护进程
   node scripts/start-detached.mjs --no-restart   # CDP 已就绪时只拉守护进程
   ```

   注意：装了自启之后环境变量已经在，通常直接跑 `--no-restart` 就够了，不用重启 WorkBuddy。

2. 验证：

   ```bash
   node src/cli.mjs status
   ```

   期望看到 `注入=true 媒体层=true 面板=true`，以及 `pages` 里有渲染页。

3. 告诉用户：WorkBuddy 右下角出现「壁纸」按钮，点开即可选壁纸和调玻璃。

## 常用命令

```bash
node src/cli.mjs status                    # 注入状态 + 当前配置
node src/cli.mjs list                      # 扫描并列出壁纸（▶ 标记当前）
node src/cli.mjs set <id|名称片段>          # 切换壁纸
node src/cli.mjs clear                     # 清除壁纸，恢复原生外观
node src/cli.mjs folder-add "D:\壁纸"       # 添加壁纸文件夹（不存在会自动创建）
node src/cli.mjs folder-remove "D:\壁纸"    # 移除壁纸文件夹
node src/cli.mjs folders                   # 列出壁纸文件夹
node src/cli.mjs scan                      # 重新扫描
node src/cli.mjs open                      # 资源管理器打开壁纸文件夹
node src/cli.mjs start / stop              # 启动 / 停止守护进程（start 单实例，重复调用安全）
node src/cli.mjs schemes                   # 列出配色预设
node scripts/autostart.mjs status          # 自启状态（环境变量 / 启动项 / 监督 / 守护 / CDP）
node scripts/autostart.mjs install         # 装自启（等同 install-autostart.bat）
node scripts/autostart.mjs uninstall       # 卸自启（等同 uninstall-autostart.bat）
node scripts/watchdog.mjs --once           # 只跑一次检查（守护进程掉了就补起来）
```

`set` / `clear` / `folder-add` 会直接改 `config.json`，运行中的守护进程会在
一个轮询周期（约 1 秒）内同步并刷新界面，无需重启。

## 停止与还原

```powershell
.\stop-wallpaper.bat
```

等价于 `node src/cli.mjs stop`：先通过 CDP 摘除注入的样式/媒体层/面板，
再结束守护进程。WorkBuddy 本体始终不被修改。

装了自启的话，`stop-wallpaper.bat` 只是临时停掉（下次登录还会自动起来）。
要**彻底取消**自启（含清掉环境变量）：

```powershell
.\uninstall-autostart.bat
```

## 架构

```
install-autostart.bat（一次）
  ├─ 用户级环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=9223
  │    └─ WorkBuddy 每次启动都自带 CDP 调试端口（官方机制）
  └─ 「启动」文件夹 → WorkBuddyWallpaperEngine.vbs（静默运行）
       └─ scripts/watchdog.mjs   每 15s 确认一次守护进程，掉了就补起来
            └─ spawn(detached) src/cli.mjs serve

apply-wallpaper.bat（手动/临时）
  └─ scripts/start-detached.mjs
       ├─ 找到 WorkBuddy.exe（自动适配非标准安装路径）
       ├─ taskkill WorkBuddyAI.exe → 带调试端口重启
       ├─ 轮询 http://127.0.0.1:9223/json/list 直到渲染页出现
       └─ spawn(detached) src/cli.mjs serve

src/cli.mjs serve（单实例：pid 已活着就直接退出）
  └─ src/engine.mjs  每 900ms 一轮：
       ├─ 同步 config.json（外部命令改的配置）
       ├─ 给每个 app.asar 渲染页注入 UI（src/page-script.js + panel-style.css）
       ├─ 消费页面动作 → 落盘 → 重新注入
       └─ 每 15s 重扫壁纸库
```

页面与宿主之间是**双通道**：

- **直达通道（优先）**：宿主用 `Runtime.addBinding` 注册 `window.__wbWeAction`；
  页面里需要即时响应的动作（`openFolder` / `rescan`）直接调它，
  CDP 事件立刻把动作推给宿主并打断休眠——不用等轮询，点击即时响应。
- **轮询队列（兜底）**：`window.__wbWe.queue` 每 900ms 被取走一次。
  binding 注册失败、或页面在绑定就绪前就调用了，都会自动落到这条路，功能不受影响。

宿主侧对**副作用动作**（`openFolder` / `rescan`）做了时间窗去重（1200ms），
所以直达和队列各送一份也只会执行一次。

## 守护边界

- **绝不**修改 `WorkBuddy.app` / `app.asar` / 安装目录，只注入活动渲染进程
- CDP 只绑定回环 `127.0.0.1`。**装了自启意味着 WorkBuddy 会长期开着这个调试端口**，
  本机上的任何程序都能借此控制 WorkBuddy 界面——这是自启换取「自动生效」的代价。
  介意的话跑 `uninstall-autostart.bat` 关掉，回到手动 `apply-wallpaper.bat`
- 注入随渲染进程存活。装了自启后**手动重启 WorkBuddy 也会自动恢复**（守护进程常驻，
  WorkBuddy 一出现就重新注入）；没装自启则需重跑 `apply-wallpaper.bat`
- 壁纸文件夹只读扫描，不移动、不删除用户的任何文件

## 自检

```bash
node --check src/cli.mjs
node src/cli.mjs doctor 2>/dev/null || node src/cli.mjs status
node src/cli.mjs list
```

## 已知边界

- 核心版**不含** Wallpaper Engine 的 Scene 场景壁纸 WebGL 渲染、ffmpeg 帧率上限转码、
  视频倍速/翻转、Edge canvas 兼容。这些是原 DSH 插件的能力，尚未移植。
- 视频壁纸通过 `file://` URL 加载（与 workbuddy-skin-studio 的图片壁纸同机制）。
  个别编码的 `.mkv` 可能无法播放，优先用 `.mp4`（H.264）或 `.webm`。
- 界面适配依赖 WorkBuddy 的 `--cb-*` 变量与 `[data-view-id]` 锚点；官方大版本更新后
  可能需要重新对齐。
