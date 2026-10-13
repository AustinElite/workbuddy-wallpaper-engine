# 故障排查手册

按**症状**组织。每条都写清了「怎么判断」和「为什么」，因为绝大多数问题
不是代码错了，而是**某条链路没在跑**。

---

## 先跑这一句

```bash
node scripts/autostart.mjs status
```

输出长这样：

```
环境变量   WORKBUDDY_REMOTE_DEBUGGING_PORT = 9223   期望 9223
登录自启   已安装  ...\Startup\WorkBuddyWallpaperEngine.vbs
快捷方式   已带调试参数  WorkBuddy AI.lnk
监督进程   运行中 pid=21812
守护进程   运行中 pid=24036
CDP        就绪
```

**这五行里任何一行不对，都能直接定位到下面的某一节。**

---

## 症状速查

| 症状 | 先看哪一行 | 跳转 |
|---|---|---|
| 重启 WorkBuddy 后没壁纸 | `CDP` / `监督进程` | [①](#-重启-workbuddy-后没壁纸) |
| 壁纸是黑的 / 画面不动 | — | [②](#-壁纸是黑的--画面不动) |
| 打开文件夹很慢 / 点了没反应 | `守护进程` | [③](#-打开文件夹很慢--点了没反应) |
| 设置页看起来像浮层 | — | [④](#-设置页看起来像浮层没嵌在面板里) |
| 收起右侧栏后设置页丢了 | — | [⑤](#-收起右侧栏后设置页丢了) |
| 关标签页要等一下才消失 | — | [⑥](#-关标签页有延迟) |
| 改了代码但界面没变 | — | [⑦](#-改了代码但界面没变) |

---

## ① 重启 WorkBuddy 后没壁纸

这是最常见的一个，而且**有两个独立的原因**，缺一不可。

### 判断

| `status` 里看到 | 原因 | 处理 |
|---|---|---|
| `CDP 未就绪` | WorkBuddy 这次不是带调试端口启动的 | 从**桌面 / 开始菜单快捷方式**重新打开它（参数已经写进快捷方式了）。如果你用别的方式启动（不是这两个快捷方式），需要**注销/重启一次系统**让环境变量对所有程序生效 |
| `监督进程 未运行` | 登录项还没触发过——你只重启了 WorkBuddy，**没有注销** | 双击 `install-autostart.bat` |
| `守护进程 未运行`、监督在跑 | 刚被监督进程拉起来 | 等 15 秒再看 |
| 都正常但界面还是没壁纸 | 注入被 React 重渲染冲掉了 | 看 `engine.log` 尾部有没有异常 |

### 为什么会这样

「重启 WorkBuddy」和「重新登录」是两件不同的事：

- **登录自启项只在登录时触发一次**。只重启应用时它根本不跑。
- **环境变量只对「环境块刷新之后」启动的进程生效**。explorer.exe 拿着旧环境块时，
  从它启动的 WorkBuddy 读不到新值。

所以 `install-autostart.bat` 铺了三条路（环境变量 + 快捷方式参数 + 常驻监督进程），
分别覆盖这三个失效场景。细节见 [ARCHITECTURE.md](ARCHITECTURE.md#为什么自启要铺三条路)。

### 兜底操作

`install-autostart.bat` 是**幂等**的——任何时候重跑都安全，不会重复装、不会装坏。
所以「不确定哪里坏了就双击一次」是个万能操作。

---

## ② 壁纸是黑的 / 画面不动

### 判断

大概率是**省电开关把视频暂停了**。视频暂停时停在当前帧，而**有些片子第一帧接近全黑**，
看起来就像「壁纸没显示」。

用 CDP 或 DevTools 看一眼就知道：

```js
window.__wbWe.mediaEl.paused        // true = 被暂停了
window.__wbWe.state.pauseOnBlur     // 「窗口失焦时暂停」
window.__wbWe.state.pauseOnBattery  // 「电池供电时暂停」
window.__wbWe.onBattery             // 现在是不是在用电池
document.hidden, document.hasFocus()
```

### 处理

在设置面板里关掉「电池供电时暂停」或「窗口失焦时暂停」。

命令行也能改（改完守护进程会自动同步）：

```bash
# 编辑 ~/.workbuddy-wallpaper-engine/config.json，把 pauseOnBattery 改成 false
```

### 为什么会这样

暂停条件是**或**关系：

```js
const blurred  = state.pauseOnBlur    && (document.hidden || !document.hasFocus());
const onBattery = state.pauseOnBattery && NS.onBattery;
if (blurred || onBattery) element.pause();
```

笔记本用电池 + `pauseOnBattery: true` → 一直暂停。
`pauseOnBlur` 是自愈的（`window.focus` 会重新触发 `syncPlayback`），
`pauseOnBattery` 不是——只要还插着电池就一直是暂停状态。

> 排查提示：**视频本身没问题。** 直接调 `await el.play()` 能成功就说明自动播放没被拦，
> 问题只在「该播的时候没人去播」。

---

## ③ 打开文件夹很慢 / 点了没反应

### 判断

```bash
node scripts/autostart.mjs status    # 看「守护进程」
```

如果 `守护进程 未运行`——**动作会堆在队列里没人消费**。
你感受到的"慢"其实是"没反应 + 延迟补执行"：直到某次守护进程起来，动作才被一次性取走。

界面上也会有反馈（v1.0 起）：宿主在线时按钮闪「处理中…」，
不在线时闪「引擎未运行」并给出提示。

### 处理

```powershell
.\install-autostart.bat     # 让守护进程常驻
```

### 为什么会这样

「打开文件夹」这类动作只有宿主能做（页面不能启动进程），走的是双通道：

- **直达通道**：`Runtime.addBinding` 注册的 `window.__wbWeAction`，
  在 CDP 事件回调里**就地执行**，端到端约 60ms
- **轮询队列**：兜底，最坏要等一个轮询周期

但两条路都需要**宿主在跑**。宿主不在，动作就只是躺在队列里。

> **排查提示：用户报"慢"的时候，先确认链路末端到底在不在跑，别一上来就优化代码。**
> 这个项目里踩过这个坑——花了几轮优化延迟，真凶其实是守护进程压根没启动。

---

## ④ 设置页看起来像浮层（没嵌在面板里）

### 判断

量矩形，别靠肉眼判断截图：

```js
const box   = document.getElementById('wb-we-settings');
const body  = document.querySelector('[data-view-id=detail-panel] .detail-main__body');
const head  = document.querySelector('.sidebar-next-main-header');
const r = (el) => el.getBoundingClientRect();
// 四条边应该和 body 完全重合，顶部应该等于 head 的下沿
```

还要确认**挂载点对不对**：

```js
box.parentElement.className   // 应该是 "detail-main__body"
box.classList.contains('is-docked')
getComputedStyle(box).position // "absolute"
```

### 为什么会这样

早期版本是挂在 `body` 上的 `position: fixed` 浮层，靠 JS 算坐标。
**坐标能对齐，但它不在面板的 DOM 里**——不参与布局和层叠，还因为面板透明
必须自带不透明底，于是永远像"贴上去的卡片"。

现在改成挂进面板的内容容器，`position: absolute; inset: 0`，坐标交给浏览器。

> **教训：要"嵌入"某块 UI，靠算坐标是做不到的，必须成为那块 UI 的子节点。**

如果发现 `parentElement` 不是 `detail-main__body`，说明被 React 踢出来了——
`ensureSettingsWatcher` 每 400ms 会补挂回去，等一下即可。

---

## ⑤ 收起右侧栏后设置页丢了

### 判断

```js
window.__wbWe.settingsOpen     // 收起面板后应该还是 true
document.querySelector('.artifact-tab--active .artifact-tab__name').textContent
// 应该还是「壁纸引擎设置」，而不是变回「新标签页」
```

### 为什么会这样

宿主（右侧面板）消失时，如果直接 `closeSettings()`，标签标题就会被还原成
「新标签页」，用户只是收个面板，状态却被永久丢掉了。

正确做法是**只藏不关**：`box.style.display = "none"`，但保持 `settingsOpen = true`；
面板再打开时自动恢复。

> **教训：「临时不可见」和「关闭」是两件事，别用 close 去实现 hide。**

---

## ⑥ 关标签页有延迟

### 判断

点设置页标签上的 ×，设置页应该**当帧消失**。如果有一顿，说明走的是轮询路径。

### 为什么会这样

× 是 **React** 在处理（它把标签关掉）。如果只靠 400ms 轮询发现"宿主没了"、
还要连续两次确认，就会有最多 ~800ms 的延迟。

修法是加一条同步通道：在 `document` 上挂 `pointerdown` 的**捕获阶段**监听，
命中"我们占用的那个标签"的 × 就立刻关。两个要点：

1. **必须用捕获阶段**——React 的关闭处理会 `stopPropagation()`，
   冒泡阶段挂在 `document` 上的监听器收不到；而 `document` 的捕获早于
   React 根容器（它是 `document` 的后代）上的任何监听器。
2. **必须挂 `pointerdown` 而不是 `click`**——React 在**按下阶段**就把标签移除了，
   等 `click` 触发时元素已经不在 DOM 里，`closest()` 找不到。

---

## ⑦ 改了代码但界面没变

这是**开发时最坑的一个**。

### 判断

回读一个只有新代码才有的标记。例如新加了一个叫 `hTabCloseDown` 的处理器：

```js
typeof window.__wbWe.hTabCloseDown   // "undefined" = 页面跑的还是旧代码
```

### 为什么会这样

`src/cli.mjs serve` 有**单实例保护**，而且**已经在跑的守护进程不会主动重新注入**——
只有配置变更（`dirty`）或新会话才注入。

所以：

```bash
node src/cli.mjs stop && node src/cli.mjs start
```

`stop` 摘除注入并结束进程，`start` 是全新会话 → **必定全量注入**。

> **教训：测注入型代码前，先确认"新代码真的在页面里"。别假设改了文件页面就变了。**

---

## 诊断技巧

这些是排查过程中真正省时间的做法：

### 用 CDP 直接量，别靠截图猜

截图会受裁剪、缩放、渲染瞬时帧影响；`getBoundingClientRect()` 不会。

```js
import { fetchTargets, CdpSession } from './src/cdp.mjs';
const targets = await fetchTargets(9223);
const session = new CdpSession(targets[0].webSocketDebuggerUrl);
await session.open();
console.log(await session.evaluate(`(() => { /* 你想量的东西 */ })()`));
```

### 验证交互要用真实鼠标事件

`element.click()` **不能**代表真实交互——很多问题只在真实事件路径上才暴露
（比如"元素在按下阶段就被移除了"）。用 CDP 派发真实事件：

```js
await session.send('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
```

### 量延迟别用 requestAnimationFrame

主线程被 React 重渲染占满时 rAF 会被**饿住**，测出 175ms 的假数据（真实是 0.3ms）。
要量"某函数多久"就直接量函数自身耗时；要量"状态何时变"就用 `MutationObserver`
（微任务），**并且必须把 observer 存到 `window` 上，否则会被 GC 掉、回调根本不触发**。

### 数关键字出现次数，而不是看文件长度

判断日志里有没有新记录时，`文件变长 && 包含关键字` 会被无关日志误触发。
正确做法是**数关键字出现次数**：

```js
const count = () => (readFileSync(LOG, 'utf8').match(/打开文件夹/g) || []).length;
```

---

## 日志位置

| 文件 | 内容 |
|---|---|
| `~/.workbuddy-wallpaper-engine/engine.log` | 守护进程：注入、动作、重扫、异常 |
| `~/.workbuddy-wallpaper-engine/watchdog.log` | 监督进程：拉起守护进程的记录（只在状态翻转时写） |
| `~/.workbuddy-wallpaper-engine/config.json` | 全部设置 |
| `~/.workbuddy-wallpaper-engine/engine.pid` | 守护进程 pid |
| `~/.workbuddy-wallpaper-engine/watchdog.pid` | 监督进程 pid |

---

## 彻底重来

```powershell
.\uninstall-autostart.bat      # 删登录项、清环境变量、还原快捷方式、杀进程
.\uninstall-skill.bat          # 移除技能
# 需要的话再删掉 ~/.workbuddy-wallpaper-engine/（配置和日志）
.\install-autostart.bat        # 重新装
```
