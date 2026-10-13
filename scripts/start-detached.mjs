#!/usr/bin/env node
// 一键启动：确保 WorkBuddy 带 CDP 调试端口运行，然后拉起壁纸引擎守护进程。
// 由用户双击 bat 调用，因此不受任何沙箱限制；守护进程以分离方式启动，窗口关掉也能继续跑。
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_CDP_PORT, resolvePaths } from "../src/constants.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.mjs");
const WATCHDOG = join(ROOT, "scripts", "watchdog.mjs");
const paths = resolvePaths();
const LOG = paths.logPath;

const PROCESS_NAMES = ["WorkBuddyAI.exe", "WorkBuddy.exe"];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const PORT = Number(argValue("--port") || DEFAULT_CDP_PORT);
const NO_RESTART = process.argv.includes("--no-restart");

writeFileSync(LOG, "");
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(LOG, line, "utf8");
  process.stdout.write(line);
};

function findExe() {
  const direct = [
    process.env.WORKBUDDY_EXE,
    "D:\\WorkBuddy\\WorkBuddy国际版\\WorkBuddyAI\\WorkBuddyAI.exe",
    "D:\\WorkBuddy\\WorkBuddy国内版\\WorkBuddyAI\\WorkBuddyAI.exe",
  ].filter(Boolean);
  for (const candidate of direct) if (existsSync(candidate)) return candidate;

  for (const root of ["D:\\WorkBuddy", "C:\\Program Files", "C:\\Program Files (x86)"]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      for (const rel of [["WorkBuddyAI", "WorkBuddyAI.exe"], ["WorkBuddy.exe"]]) {
        const candidate = join(root, entry, ...rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function cdpReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const list = await response.json();
    return Array.isArray(list) && list.some((t) => String(t.url || "").includes("app.asar"));
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReady()) return true;
    await sleep(500);
  }
  return false;
}

function kill(image) {
  try {
    execFileSync("taskkill", ["/F", "/IM", image], { stdio: "ignore" });
    log(`已结束进程 ${image}`);
  } catch {
    // 进程本来就不在
  }
}

function killPreviousDaemon() {
  try {
    const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid);
      log(`已结束旧的守护进程 pid=${pid}`);
    }
  } catch {
    // 没有旧守护进程
  }
}

(async () => {
  log(`WorkBuddy Wallpaper Engine 启动中：port=${PORT}`);

  if (await cdpReady()) {
    log("CDP 已就绪，跳过重启");
  } else if (NO_RESTART) {
    log("错误：CDP 未就绪，且指定了 --no-restart");
    process.exit(1);
  } else {
    const exe = findExe();
    if (!exe) {
      log("错误：未找到 WorkBuddy 可执行文件");
      process.exit(1);
    }
    log(`可执行文件：${exe}`);

    for (const name of PROCESS_NAMES) kill(name);
    await sleep(2500);

    // 双保险拿调试端口：
    //   ① WORKBUDDY_REMOTE_DEBUGGING_PORT —— WorkBuddy 官方读它，会自己 appendSwitch
    //      remote-debugging-port，并顺带加上 remote-allow-origins；
    //   ② --remote-debugging-port 命令行参数 —— Electron 原生支持，作为兜底。
    const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(PORT) },
    });
    child.unref();
    log(`已以调试模式启动 WorkBuddy，pid=${child.pid}`);

    if (!(await waitForCdp(60000))) {
      log("错误：60 秒内未检测到 CDP 渲染进程");
      process.exit(1);
    }
    log("CDP 就绪");
  }

  killPreviousDaemon();
  await sleep(600);

  // 拉起的是「监督进程」而不是守护进程本身：监督进程常驻，守护进程掉了会自动补起来，
  // 而且它会一直盯着 CDP —— 这样手动启动一次就等价于把自启那套也装上了。
  const watchdog = spawn(process.execPath, [WATCHDOG, "--port", String(PORT)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(PORT) },
  });
  watchdog.unref();
  log(`监督进程已启动，pid=${watchdog.pid}（它会负责守护进程）`);
  await sleep(1500);

  log(`日志：${LOG}`);
  log("完成。WorkBuddy 右下角会出现「壁纸」按钮。");
})();
