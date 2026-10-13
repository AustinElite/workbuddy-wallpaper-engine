#!/usr/bin/env node
// 常驻监督进程：保证壁纸守护进程一直活着。
//
// 为什么需要它：守护进程负责「注入 UI + 消费页面动作」，它一旦挂了，
// 就没人去注入，表现就是「打开 WorkBuddy 没有壁纸」。
// 而启动文件夹里的自启项只在**登录时**跑一次，用户只是重启 WorkBuddy
// （没注销）时根本不会触发 —— 这就是「重启后没壁纸」的根因。
//
// 本进程由启动文件夹在登录时静默拉起，之后每 15 秒确认一次守护进程，
// 掉了就补起来。于是只要它活着，「重启 WorkBuddy 一定有壁纸」。
//
// 用法：node scripts/watchdog.mjs [--port 9223] [--once]
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_CDP_PORT, resolvePaths } from "../src/constants.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.mjs");
const paths = resolvePaths();
const WATCHDOG_PID = join(paths.installRoot, "watchdog.pid");
const WATCHDOG_LOG = join(paths.installRoot, "watchdog.log");

const CHECK_MS = 15000;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const PORT = Number(argValue("--port") || DEFAULT_CDP_PORT);
const ONCE = process.argv.includes("--once");

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(WATCHDOG_LOG, line, "utf8");
  } catch {
    // 日志失败不影响监督
  }
  if (process.env.WBWE_VERBOSE) process.stdout.write(line);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  try {
    return Number(readFileSync(file, "utf8").trim());
  } catch {
    return NaN;
  }
}

function daemonAlive() {
  return pidAlive(readPid(paths.pidPath));
}

function startDaemon() {
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(PORT)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// 已经有监督进程在跑就别重复起（登录项 + 手动双击可能同时触发）
function alreadyRunning() {
  const pid = readPid(WATCHDOG_PID);
  return Number.isInteger(pid) && pid !== process.pid && pidAlive(pid) ? pid : null;
}

function cleanup() {
  try {
    if (readPid(WATCHDOG_PID) === process.pid) rmSync(WATCHDOG_PID, { force: true });
  } catch {
    // 忽略
  }
}

(async () => {
  const other = alreadyRunning();
  if (other) {
    log(`已有监督进程 pid=${other}，本次退出`);
    return;
  }

  mkdirSync(paths.installRoot, { recursive: true });
  writeFileSync(WATCHDOG_PID, String(process.pid), "utf8");
  log(`监督进程启动：pid=${process.pid} port=${PORT} 检查间隔=${CHECK_MS}ms`);

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  let down = false;
  for (;;) {
    if (!daemonAlive()) {
      const pid = startDaemon();
      // 只在「从有到无」时记一次，避免反复刷日志
      log(down ? `守护进程仍未起来，再次拉起 pid=${pid}` : `守护进程不在，已拉起 pid=${pid}`);
      down = true;
    } else if (down) {
      log("守护进程已就绪");
      down = false;
    }
    if (ONCE) break;
    await sleep(CHECK_MS);
  }

  // --once 跑完要清掉 pid 文件，否则留下一个指向死进程的桩
  cleanup();
})();
