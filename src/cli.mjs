#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CDP_PORT, resolvePaths } from "./constants.mjs";
import { SCHEMES, loadConfig, resolvePalette, saveConfig } from "./config.mjs";
import { formatSize, scanFolders, visibleItems } from "./scanner.mjs";
import { fetchTargets } from "./cdp.mjs";
import { createLogger, engineStatus, runEngine, stopEngine, writePid } from "./engine.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[token.slice(2)] = next;
        index += 1;
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function portOf(flags) {
  const port = Number(flags.port ?? DEFAULT_CDP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--port 必须是 1024–65535 的整数，收到：${flags.port}`);
  }
  return port;
}

function startDetachedDaemon(port) {
  const child = spawn(process.execPath, [CLI_PATH, "serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// 读 pid 文件并确认那个进程真的活着（pid 文件可能是上次异常退出留下的）
function liveDaemonPid() {
  const paths = resolvePaths();
  try {
    const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function stopDaemon(port) {
  const paths = resolvePaths();
  const result = await stopEngine({ port, onLog: createLogger(paths.logPath) });
  let killed = false;
  try {
    const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      process.kill(pid);
      killed = true;
    }
  } catch {
    // 没有 PID 文件说明守护进程本来就没跑
  }
  return { removed: result.removed, killed };
}

// 首次使用时把默认壁纸目录写进配置，避免 list/set 拿到空文件夹
async function loadConfigWithFolders(paths) {
  const config = await loadConfig();
  if (config.folders.length > 0) return config;
  await mkdir(paths.defaultWallpaperDir, { recursive: true });
  return saveConfig({ ...config, folders: [paths.defaultWallpaperDir] });
}

function matchItem(items, needle) {
  if (!needle) return null;
  const exact = items.find((item) => item.id === needle);
  if (exact) return exact;
  const prefix = items.filter((item) => item.id.startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  const lowered = String(needle).toLowerCase();
  const byName = items.filter((item) => item.name.toLowerCase().includes(lowered));
  if (byName.length >= 1) return byName[0];
  return null;
}

export async function runCli(argv) {
  const command = argv[0] ?? "help";
  const { flags, positional } = parseArgs(argv.slice(1));
  const paths = resolvePaths();
  const port = portOf(flags);

  if (command === "help") {
    return {
      usage: "wbwe <command> [options]",
      commands: [
        "start [--port 9223]        后台启动守护进程（需 WorkBuddy 已带调试端口运行）",
        "serve [--port 9223]        前台运行守护进程（供 start 内部调用）",
        "stop  [--port 9223]        摘除壁纸并结束守护进程",
        "status                     查看注入状态与当前配置",
        "list                       扫描并列出现有壁纸",
        "set <id|名称>              切换当前壁纸",
        "clear                      清除壁纸，恢复原生外观",
        "scan                       重新扫描壁纸文件夹",
        "folders                    列出壁纸文件夹",
        "folder-add <路径>          添加壁纸文件夹",
        "folder-remove <路径>       移除壁纸文件夹",
        "open                       在资源管理器中打开壁纸文件夹",
      ],
    };
  }

  if (command === "serve") {
    // 单实例：监督进程、登录自启项、手动双击可能同时触发，
    // 跑两个守护进程会重复注入（UI 叠两份）。已有活着的就退出。
    const existing = liveDaemonPid();
    if (existing) {
      return { served: false, reason: `已有守护进程在跑 pid=${existing}` };
    }
    await writePid();
    const log = createLogger(paths.logPath);
    await runEngine({ port, onLog: log });
    return { served: true };
  }

  if (command === "start") {
    const pid = startDetachedDaemon(port);
    return { started: true, pid, port, log: paths.logPath };
  }

  if (command === "stop" || command === "restore") {
    return stopDaemon(port);
  }

  if (command === "status") {
    const config = await loadConfigWithFolders(paths);
    let pages = [];
    try {
      pages = await engineStatus({ port });
    } catch (error) {
      pages = [{ error: error.message }];
    }
    const items = await scanFolders(config.folders);
    return {
      port,
      config: {
        ...config,
        palette: resolvePalette(config),
      },
      wallpaperCount: items.length,
      activeName: items.find((item) => item.id === config.activeId)?.name ?? null,
      pages,
      log: paths.logPath,
    };
  }

  if (command === "list" || command === "scan") {
    const config = await loadConfigWithFolders(paths);
    const items = await scanFolders(config.folders);
    return {
      folders: config.folders,
      count: items.length,
      activeId: config.activeId,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        size: item.sizeText,
        folder: item.folder,
        file: item.file,
        active: item.id === config.activeId,
      })),
    };
  }

  if (command === "set") {
    const config = await loadConfigWithFolders(paths);
    const items = await scanFolders(config.folders);
    const target = matchItem(items, positional[0]);
    if (!target) throw new Error(`找不到壁纸：${positional[0] ?? "(未指定)"}`);
    await saveConfig({ ...config, activeId: target.id });
    return { activeId: target.id, name: target.name, file: target.file };
  }

  if (command === "clear") {
    const config = await loadConfigWithFolders(paths);
    await saveConfig({ ...config, activeId: null });
    return { activeId: null };
  }

  if (command === "folders") {
    const config = await loadConfigWithFolders(paths);
    return { folders: config.folders, defaultFolder: paths.defaultWallpaperDir };
  }

  if (command === "folder-add") {
    const raw = positional[0];
    if (!raw) throw new Error("folder-add 需要目录路径");
    const dir = resolve(raw);
    await mkdir(dir, { recursive: true });
    const config = await loadConfigWithFolders(paths);
    const next = await saveConfig({ ...config, folders: [...config.folders, dir] });
    return { folders: next.folders, added: dir };
  }

  if (command === "folder-remove") {
    const raw = positional[0];
    if (!raw) throw new Error("folder-remove 需要目录路径");
    const dir = resolve(raw);
    const config = await loadConfigWithFolders(paths);
    const next = await saveConfig({
      ...config,
      folders: config.folders.filter((folder) => resolve(folder) !== dir),
    });
    return { folders: next.folders, removed: dir };
  }

  if (command === "open") {
    const config = await loadConfigWithFolders(paths);
    const dir = config.folders[0] ?? paths.defaultWallpaperDir;
    await mkdir(dir, { recursive: true });
    const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" });
    child.unref();
    return { opened: dir };
  }

  if (command === "doctor") {
    const config = await loadConfigWithFolders(paths);
    const items = await scanFolders(config.folders);
    let cdp;
    try {
      const targets = await fetchTargets(port);
      cdp = targets.length > 0 ? `ok（${targets.length} 个渲染页）` : "端口通，但没有 app.asar 渲染页";
    } catch (error) {
      cdp = `不可用：${error.message}`;
    }
    return {
      node: process.version,
      platform: process.platform,
      installRoot: paths.installRoot,
      configPath: paths.configPath,
      logPath: paths.logPath,
      folders: config.folders,
      wallpaperCount: items.length,
      port,
      cdp,
    };
  }

  if (command === "schemes") {
    return { schemes: SCHEMES, active: (await loadConfig()).scheme };
  }

  throw new Error(`未知命令：${command}`);
}

function printHuman(command, result) {
  if (command === "list" || command === "scan") {
    if (!result.items?.length) {
      process.stdout.write(`未找到壁纸。文件夹：${result.folders.join(", ") || "(未配置)"}\n`);
      return;
    }
    process.stdout.write(`共 ${result.count} 项：\n`);
    for (const item of result.items) {
      process.stdout.write(
        `  ${item.active ? "▶" : " "} ${item.kind.padEnd(5)} ${String(item.size).padStart(9)}  ${item.name}  (${item.id})\n`,
      );
    }
    return;
  }
  if (command === "status") {
    process.stdout.write(
      `端口 ${result.port} · 壁纸 ${result.wallpaperCount} 项 · 当前：${result.activeName ?? "无"}\n` +
        `配色 ${result.config.palette.label} · 玻璃 ${result.config.glass}% · 适配 ${result.config.mode}\n`,
    );
    for (const page of result.pages) {
      process.stdout.write(
        page.error
          ? `  页面不可用：${page.error}\n`
          : `  面板样式=${page.panelStyle} 壁纸样式=${page.skinStyle} 媒体层=${page.media} 当前=${page.activeId ?? "无"}\n`,
      );
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const command = process.argv[2] ?? "help";
  runCli(process.argv.slice(2))
    .then((result) => {
      printHuman(command, result);
      if (command === "serve") process.stdout.write("守护进程已结束\n");
    })
    .catch((error) => {
      process.stderr.write(`壁纸引擎：${error.message}\n`);
      process.exitCode = 1;
    });
}

export { formatSize, visibleItems };
