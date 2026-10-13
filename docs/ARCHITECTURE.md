# 架构说明

面向想改代码 / 做二次开发的人。用户向的说明看 [README](../README.md)。

---

## 一句话

不碰 `app.asar`，只通过 **本地 CDP** 往活动渲染进程里注入样式和脚本，
把壁纸图层垫到界面后方，并把应用的设计变量接到壁纸上。

## 进程模型

```
install-autostart.bat（一次性）
  ├─ ① 用户级环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=9223
  ├─ ② WorkBuddy 快捷方式追加 --remote-debugging-port / --remote-allow-origins
  └─ ③ 「启动」文件夹 → WorkBuddyWallpaperEngine.vbs（隐藏运行）
        └─ scripts/watchdog.mjs          常驻监督进程
             └─ spawn(detached) src/cli.mjs serve
                  └─ src/engine.mjs       守护进程主循环

apply-wallpaper.bat（手动，一次性）
  └─ scripts/start-detached.mjs
       ├─ 定位 WorkBuddy.exe（适配非标准安装路径）
       ├─ 带调试端口重启 WorkBuddy
       ├─ 轮询 http://127.0.0.1:9223/json/list 直到渲染页出现
       └─ spawn(detached) scripts/watchdog.mjs
```

三层各自的职责：

| 层 | 文件 | 职责 | 生命周期 |
|---|---|---|---|
| 监督进程 | `scripts/watchdog.mjs` | 每 15s 确认守护进程，掉了补起来 | 登录 → 关机 |
| 守护进程 | `src/cli.mjs serve` → `src/engine.mjs` | 注入、同步配置、消费动作 | 常驻，单实例 |
| 页面脚本 | `src/page-script.js` | 渲染 UI、采集用户操作 | 随渲染进程存活 |

### 为什么自启要铺三条路

这三条解决的是**三个不同的失效场景**，缺一个都会出现「重启后没壁纸」：

1. **环境变量**解决「WorkBuddy 默认不带调试端口」。
   但它只对**环境块刷新之后**启动的进程生效——explorer.exe 拿着旧环境块时，
   从它启动的 WorkBuddy 读不到新值，通常得注销一次。
2. **快捷方式参数**解决第 1 条的延迟。快捷方式的启动参数是**立刻生效**的，
   不依赖任何刷新。所以从桌面 / 开始菜单打开就一定带端口。
3. **「启动」文件夹的启动器**解决「谁来常驻」。
   启动项只在**登录时**触发一次，所以它拉起的是**监督进程**而不是守护进程本身——
   监督进程会一直活着，守护进程掉了它补，于是「重启应用」这种随时发生的需求才有保障。

> **通用教训：不要用一个「一次性触发」的机制去保障一个「随时发生」的需求。**
> 要么让触发点跟着需求走（快捷方式参数），要么让保障者常驻（监督进程）。

### 为什么守护进程要单实例

`src/cli.mjs serve` 启动时先读 pid 文件 + `kill(pid, 0)` 探活，已有活着的就退出。
因为监督进程、登录项、手动双击可能同时触发，跑出两个守护进程会**重复注入**（UI 叠两份）。

## 引擎主循环

`src/engine.mjs` 的 `runEngine()`，每轮约 300ms：

```
1. loadConfig()                  读盘，和内存里的对比；外部命令改过就同步
2. pendingActions                先处理 binding 直达进来的动作（不等轮询）
3. fetchTargets(port)            拉渲染页列表
4. 每个 target：
     ├─ 新会话 → Runtime.enable + Runtime.addBinding + 全量注入
     ├─ dirty  → 全量注入（buildExpression：状态 JSON + CSS + 页面脚本）
     └─ 否则   → 只取队列（buildQueueDrain，顺带写心跳 lastBeat）
5. 每 15s 重扫壁纸库
6. 没有待办就 sleep(300ms)，等 binding 事件或超时唤醒
```

**为什么 `openFolder` 在事件回调里就地执行**：交给主循环的话，万一此刻循环正卡在
`fetchTargets` 上（Chromium 的 `/json/list` 经常要 100ms+），就得白等一整轮。
就地执行把端到端延迟从 ~460ms 压到 ~60ms。`lastSideEffectAt` 时间窗保证
队列里那份会被跳过，不会开两个窗口。

## 页面 ↔ 宿主 双通道

| 通道 | 机制 | 用途 |
|---|---|---|
| 直达（优先） | 宿主 `Runtime.addBinding` 注册 `window.__wbWeAction`，页面直接调用 | 需要即时响应的动作 |
| 轮询（兜底） | `window.__wbWe.queue` 每 300ms 被取走 | binding 不可用时的退路 |

宿主侧对副作用动作做时间窗去重，所以两条路各送一份也只执行一次。

### 心跳

`buildQueueDrain()` 每轮顺手写 `ns.lastBeat = Date.now()`。
页面用 `hostAlive()`（`Date.now() - lastBeat < 3000`）判断宿主在不在——
**守护进程没跑时动作会石沉大海，界面必须说清楚，不能装作点了没反应。**

## 注入策略：怎么和 React 共处

应用是 React 管的，注入的节点随时可能被重渲染冲掉。这里用的几招：

| 招式 | 用在哪 | 为什么 |
|---|---|---|
| 把开关挂在 `<html>` 的类上 | `html.wb-we-settings-open .detail-new-tab-landing { visibility: hidden }` | React 动不到 `<html>`，比改它管理的节点稳 |
| MutationObserver + 节流 | 重挂落地页入口、补挂设置页 | React 把节点冲掉后能自动补回来 |
| `rebind()` 统一挂载 | 所有事件监听 | 每次注入先摘旧的再挂新的，避免闭包锁死旧函数 |
| 从真实节点 `cloneNode` | 落地页入口 | 样式天然一致，不用手抄 CSS |
| **只改现有节点的文字/图标** | 标签页就地改名 | 比注入新节点稳得多：不碰 React 的 children 列表 |

### 两个必须踩对的坑

**① 捕获阶段 vs 冒泡阶段。** React 17+ 把事件委托挂在 root 容器（`document` 的后代）上。
所以**冒泡阶段**里，React 的处理器先于 `document` 上的监听器执行；
要抢在它前面（或者它 `stopPropagation()` 了）就必须用**捕获阶段**。

**② `click` vs `pointerdown`。** React 可能在**按下阶段**就把节点移除了，
等 `click` 触发时元素已经不在 DOM 里，`closest()` 找不到——监听器等于白挂。

## 设置页为什么挂在面板内部

早期版本把设置页做成挂在 `body` 上的 `position: fixed` 浮层，靠 JS 算坐标去贴面板。
**坐标能对齐，但它不在面板的 DOM 里**——不参与面板的布局和层叠，还因为面板透明
而必须自带一层不透明底，于是永远看起来像一块"贴上去的卡片"。

现在改成挂进面板自己的内容容器：

```
[data-view-id=detail-panel]
  └ .detail-panel-container
      └ .sidebar-next
          └ .sidebar-next-body
              └ .detail-panel > .detail-layout__content
                  └ .detail-main > .detail-main__body   ← 挂这里
                      ├ .detail-new-tab-landing
                      └ #wb-we-settings   (position: absolute; inset: 0)
```

**要"嵌入"某块 UI，靠算坐标是做不到的——必须成为那块 UI 的子节点。**

## 配置与持久化

宿主端 `~/.workbuddy-wallpaper-engine/config.json`：

```jsonc
{
  "folders": ["..."],        // 壁纸文件夹
  "activeId": "bb63673dacd8",// 当前壁纸
  "mode": "cover",           // cover | contain | fill
  "brightness": 94,
  "saturation": 84,
  "glass": 60,               // 玻璃透明度 0–60
  "scheme": "aurora",
  "pauseOnBlur": true,
  "pauseOnBattery": true,
  "hidden": [],              // 用户手动隐藏的壁纸
  "port": 9223
}
```

界面改设置 → 页面 push 动作 → 守护进程落盘 → 重新注入。
命令行改设置 → 直接写文件 → 守护进程下轮 loadConfig 发现差异 → 重新注入。
**两条路都汇到同一份文件，所以不会打架。**

## 非目标

- 不修改 `app.asar` / 安装目录（这是硬边界）
- 不做 Scene 场景壁纸的 WebGL 渲染、ffmpeg 转码、视频倍速/翻转
- 不移动 / 删除用户的任何文件（壁纸文件夹只读扫描）
