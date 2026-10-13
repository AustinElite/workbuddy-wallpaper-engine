import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_CDP_PORT, resolvePaths } from "./constants.mjs";
import { SCHEMES, loadConfig, normalizeConfig, resolvePalette, saveConfig } from "./config.mjs";
import { scanFolders, visibleItems } from "./scanner.mjs";
import { CdpSession, fetchTargets } from "./cdp.mjs";
import { buildInjection, buildQueueDrain, buildProbe, buildTeardown } from "./ui.mjs";

const POLL_MS = 300;
const RESCAN_MS = 15000;
// 页面通过这个 binding 把动作直达宿主，不必等轮询（点「打开文件夹」之类要即时响应）
const BINDING_NAME = "__wbWeAction";
// 副作用动作的最小间隔：binding 与队列会各送一份，靠时间窗避免重复执行。
// 同一个动作的两份是在同一轮里先后到达的（间隔≈0），所以这个窗口只要够小就行——
// 设太大反而会把用户 1 秒内的正常连点也吞掉。
const SIDE_EFFECT_GAP_MS = 500;

export function createLogger(logPath = resolvePaths().logPath) {
  try {
    mkdirSync(resolvePaths().installRoot, { recursive: true });
  } catch {
    // 目录已存在
  }
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      appendFileSync(logPath, line, "utf8");
    } catch {
      // 日志失败不影响主流程
    }
    if (process.env.WBWE_VERBOSE) process.stdout.write(line);
  };
}

function openInExplorer(dir) {
  try {
    const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runEngine({ port = DEFAULT_CDP_PORT, onLog = () => {}, once = false, maxTicks = Infinity } = {}) {
  const paths = resolvePaths();
  await mkdir(paths.installRoot, { recursive: true });

  let config = await loadConfig();
  if (config.folders.length === 0) {
    await mkdir(paths.defaultWallpaperDir, { recursive: true });
    config = await saveConfig({ ...config, folders: [paths.defaultWallpaperDir] });
  }
  if (config.port !== port) config = await saveConfig({ ...config, port });

  let items = await scanFolders(config.folders);
  let lastScan = Date.now();
  let dirty = true;

  const sessions = new Map();
  // binding 直达的动作先落这里，再由主循环消费
  const pendingActions = [];
  const lastSideEffectAt = { openFolder: 0, rescan: 0 };
  // 常驻守护进程：CDP 掉线期间只记一次日志
  let cdpDownLogged = false;
  let wakeResolver = null;
  const wake = () => {
    if (wakeResolver) {
      const resolve = wakeResolver;
      wakeResolver = null;
      resolve();
    }
  };

  onLog(`守护进程启动：port=${port} 文件夹=${config.folders.length} 壁纸=${items.length}`);

  async function buildExpression() {
    return buildInjection({
      config,
      palette: resolvePalette(config),
      items: visibleItems(items, config),
      schemes: SCHEMES,
    });
  }

  async function applyActions(actions) {
    let changed = false;
    // 副作用类动作去重：守护进程没跑时用户可能连点多次，
    // 一次性消费会把「打开文件夹」弹出十几个窗口。
    const sideEffects = new Set();

    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      const type = action.type;

      if (type === "setActive") {
        config.activeId = typeof action.id === "string" && action.id ? action.id : null;
        changed = true;
      } else if (type === "set" && action.patch && typeof action.patch === "object") {
        config = normalizeConfig({ ...config, ...action.patch });
        changed = true;
      } else if (type === "hide") {
        if (typeof action.id === "string" && action.id) {
          config.hidden = [...new Set([...config.hidden, action.id])];
          if (config.activeId === action.id) config.activeId = null;
          changed = true;
        }
      } else if (type === "rescan") {
        const now = Date.now();
        if (sideEffects.has("rescan")) continue;
        sideEffects.add("rescan");
        if (now - lastSideEffectAt.rescan < SIDE_EFFECT_GAP_MS) continue;
        lastSideEffectAt.rescan = now;
        items = await scanFolders(config.folders);
        changed = true;
      } else if (type === "openFolder") {
        const now = Date.now();
        if (sideEffects.has("openFolder")) continue;
        sideEffects.add("openFolder");
        if (now - lastSideEffectAt.openFolder < SIDE_EFFECT_GAP_MS) continue;
        lastSideEffectAt.openFolder = now;
        const dir = config.folders[0] ?? paths.defaultWallpaperDir;
        const ok = openInExplorer(dir);
        onLog(`打开文件夹 ${dir}：${ok ? "成功" : "失败"}`);
      }
    }
    if (changed) {
      config = await saveConfig({ ...config, updatedAt: Date.now() });
      onLog(`配置已保存：active=${config.activeId ?? "无"} glass=${config.glass} scheme=${config.scheme}`);
    }
    return changed;
  }

  let ticks = 0;
  for (;;) {
    if (ticks >= maxTicks) break;
    ticks += 1;

    try {
      // 外部命令（cli set / folder-add / clear）直接改 config.json，这里同步进来
      const diskConfig = await loadConfig();
      if (JSON.stringify(diskConfig) !== JSON.stringify(config)) {
        config = diskConfig;
        dirty = true;
        onLog("检测到外部配置变更，已同步");
      }

      // binding 直达的动作优先处理，不等队列
      if (pendingActions.length > 0) {
        const batch = pendingActions.splice(0, pendingActions.length);
        if (await applyActions(batch)) dirty = true;
      }

      let targets = [];
      // 守护进程会常驻（登录自启），WorkBuddy 没开时不能每轮都写日志，
      // 否则 900ms 一条会把 engine.log 刷爆。只在状态翻转时记一次。
      let cdpOk = true;
      try {
        targets = await fetchTargets(port);
      } catch (error) {
        cdpOk = false;
        if (!cdpDownLogged) {
          cdpDownLogged = true;
          onLog(`CDP 未就绪，等待 WorkBuddy 以调试端口启动：${error.message}`);
        }
      }
      if (cdpOk && cdpDownLogged) {
        cdpDownLogged = false;
        onLog("CDP 已就绪，开始注入");
      }

      const seen = new Set();
      for (const target of targets) {
        seen.add(target.id);
        let entry = sessions.get(target.id);
        if (!entry || entry.session.closed) {
          const session = new CdpSession(target.webSocketDebuggerUrl, {
            onEvent: (message) => {
              if (message.method !== "Runtime.bindingCalled") return;
              const params = message.params || {};
              if (params.name !== BINDING_NAME) return;
              let action = null;
              try {
                action = JSON.parse(params.payload);
              } catch {
                return;
              }
              if (!action || typeof action !== "object") return;
              pendingActions.push(action);
              // 「打开文件夹」是纯副作用，就地执行：交给主循环的话，万一此刻循环
              // 正卡在 fetchTargets 上（Chromium 的 /json/list 经常要 100ms+），
              // 就得白等一整轮。这里直接做，延迟降到毫秒级。
              // lastSideEffectAt 时间窗保证队列里那份会被 applyActions 跳过，不会开两个窗口。
              if (action.type === "openFolder") {
                const now = Date.now();
                if (now - lastSideEffectAt.openFolder >= SIDE_EFFECT_GAP_MS) {
                  lastSideEffectAt.openFolder = now;
                  const dir = config.folders[0] ?? paths.defaultWallpaperDir;
                  const ok = openInExplorer(dir);
                  onLog(`打开文件夹 ${dir}：${ok ? "成功" : "失败"}`);
                }
              }
              wake(); // 立刻打断休眠，别等下一轮轮询
            },
          });
          try {
            await session.open();
          } catch (error) {
            onLog(`连接渲染页失败：${error.message}`);
            continue;
          }
          // 注册直达通道；失败也无所谓，队列轮询仍然兜底
          try {
            await session.send("Runtime.addBinding", { name: BINDING_NAME });
          } catch (error) {
            onLog(`注册直达通道失败，回退到轮询：${error.message}`);
          }
          entry = { id: target.id, session, fresh: true };
          sessions.set(target.id, entry);
        }

        try {
          if (entry.fresh || dirty) {
            await entry.session.evaluate(await buildExpression());
            entry.fresh = false;
          }
          const actions = await entry.session.evaluate(buildQueueDrain());
          if (Array.isArray(actions) && actions.length > 0) {
            if (await applyActions(actions)) dirty = true;
          }
        } catch (error) {
          onLog(`页面交互失败：${error.message}`);
          entry.session.close();
          sessions.delete(target.id);
        }
      }

      for (const [id, entry] of sessions) {
        if (!seen.has(id)) {
          entry.session.close();
          sessions.delete(id);
        }
      }

      dirty = false;

      if (Date.now() - lastScan > RESCAN_MS) {
        const next = await scanFolders(config.folders);
        const changed =
          next.length !== items.length || next.some((item, index) => item.id !== items[index]?.id);
        if (changed) {
          items = next;
          dirty = true;
          onLog(`壁纸库更新：${items.length} 项`);
        }
        lastScan = Date.now();
      }
    } catch (error) {
      onLog(`循环异常：${error.message}`);
    }

    if (once) break;
    // 本轮跑完又有新动作进来了 → 立刻再跑一轮，不睡
    if (pendingActions.length > 0) continue;
    // 否则等轮询；期间若有 binding 事件，wake() 会提前打断休眠
    await Promise.race([
      sleep(POLL_MS),
      new Promise((resolve) => {
        wakeResolver = resolve;
      }),
    ]);
  }

  for (const entry of sessions.values()) entry.session.close();
  onLog("守护进程退出");
  return { ticks, sessions: sessions.size };
}

// 由 CLI 调用：先摘除注入，再结束守护进程
export async function stopEngine({ port = DEFAULT_CDP_PORT, onLog = () => {} } = {}) {
  let removed = 0;
  try {
    const targets = await fetchTargets(port);
    for (const target of targets) {
      const session = new CdpSession(target.webSocketDebuggerUrl);
      try {
        await session.open();
        await session.evaluate(buildTeardown());
        removed += 1;
      } catch (error) {
        onLog(`摘除注入失败：${error.message}`);
      } finally {
        session.close();
      }
    }
  } catch (error) {
    onLog(`CDP 不可用，跳过摘除：${error.message}`);
  }
  return { removed };
}

export async function engineStatus({ port = DEFAULT_CDP_PORT } = {}) {
  const targets = await fetchTargets(port);
  const pages = [];
  for (const target of targets) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    try {
      await session.open();
      pages.push({ id: target.id, url: target.url, ...(await session.evaluate(buildProbe())) });
    } catch (error) {
      pages.push({ id: target.id, url: target.url, error: error.message });
    } finally {
      session.close();
    }
  }
  return pages;
}

export async function writePid() {
  const paths = resolvePaths();
  await mkdir(paths.installRoot, { recursive: true });
  await writeFile(paths.pidPath, String(process.pid), "utf8");
}
