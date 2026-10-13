#!/usr/bin/env node
// 让「打开 WorkBuddy 就自动有壁纸」。两件事：
//
//   1) 写用户级环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT。
//      WorkBuddy 官方支持这个变量（启动时会自己 appendSwitch('remote-debugging-port')
//      并顺带加上 remote-allow-origins），所以设一次之后，
//      **无论用户从任务栏、开始菜单还是桌面快捷方式打开，都自带 CDP 调试端口**。
//      这比改快捷方式 / 每次杀进程带 --remote-debugging-port 重启都干净。
//
//   2) 在「启动」文件夹放一个隐藏 VBS，登录时静默拉起壁纸守护进程。
//      守护进程本身会一直轮询 CDP，WorkBuddy 一出现就自动注入。
//
// 两者就位后，以后打开 WorkBuddy 壁纸自动出现，不用再跑任何脚本。
//
// 用法：node scripts/autostart.mjs install|uninstall|status [--port 9223]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CDP_PORT, PRODUCT_NAME, resolvePaths } from "../src/constants.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.mjs");
const WATCHDOG = join(ROOT, "scripts", "watchdog.mjs");
const paths = resolvePaths();
const STATE_PATH = join(paths.installRoot, "autostart.json");
const WATCHDOG_PID = join(paths.installRoot, "watchdog.pid");

// WorkBuddy 官方读取的环境变量名（见 app.asar 内 applyCliCommandLineSwitches）
const ENV_NAME = "WORKBUDDY_REMOTE_DEBUGGING_PORT";
const VBS_NAME = "WorkBuddyWallpaperEngine.vbs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const command = (process.argv[2] || "status").toLowerCase();
const PORT = Number(argValue("--port") || DEFAULT_CDP_PORT);

function startupDir() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
const VBS_PATH = join(startupDir(), VBS_NAME);

// 用户可能从桌面 / 开始菜单打开 WorkBuddy，这两个地方的快捷方式都铺上调试参数。
const SHORTCUT_CANDIDATES = [
  join(process.env.USERPROFILE || homedir(), "Desktop", "WorkBuddy AI.lnk"),
  join(process.env.USERPROFILE || homedir(), "Desktop", "WorkBuddy.lnk"),
  join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "WorkBuddy AI.lnk"),
  join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "WorkBuddy.lnk"),
];

function debugArgs(port) {
  return `--remote-debugging-port=${port} --remote-allow-origins=http://127.0.0.1,http://localhost`;
}

// 把调试参数写进 WorkBuddy 的快捷方式。
// 为什么两条路都要铺：环境变量要等 explorer 刷新环境块才生效（通常得注销一次才稳），
// 而快捷方式的启动参数是**立刻生效**的。只靠环境变量的话，
// 「重启 WorkBuddy 却没带调试端口」就会反复出现。
// 安全约束：只改 TargetPath 指向 WorkBuddyAI.exe 的快捷方式，其它一律跳过。
function patchShortcuts(port, { remove = false } = {}) {
  const results = [];
  for (const path of SHORTCUT_CANDIDATES) {
    if (!existsSync(path)) continue;
    const q = path.replace(/'/g, "''");
    const script = remove
      ? [
          "$sh = New-Object -ComObject WScript.Shell",
          `$lnk = $sh.CreateShortcut('${q}')`,
          "if ($lnk.TargetPath -notlike '*WorkBuddyAI.exe') { Write-Output 'SKIP'; exit }",
          "$lnk.Arguments = ($lnk.Arguments -replace '--remote-debugging-port=\\d+', '' -replace '--remote-allow-origins=\\S+', '').Trim()",
          "$lnk.Save()",
          "Write-Output 'REVERTED'",
        ].join("; ")
      : [
          "$sh = New-Object -ComObject WScript.Shell",
          `$lnk = $sh.CreateShortcut('${q}')`,
          "if ($lnk.TargetPath -notlike '*WorkBuddyAI.exe') { Write-Output 'SKIP'; exit }",
          "if ($lnk.Arguments -like '*remote-debugging-port*') { Write-Output 'ALREADY'; exit }",
          `$lnk.Arguments = ($lnk.Arguments + ' ${debugArgs(port)}').Trim()`,
          "$lnk.Save()",
          "Write-Output 'PATCHED'",
        ].join("; ");
    try {
      results.push({ path, status: ps(script).trim() });
    } catch (error) {
      results.push({ path, status: `FAILED: ${error.message}` });
    }
  }
  return results;
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("自启安装只支持 Windows（WorkBuddy 桌面端目前只有 Windows 版）");
  }
}

/* ---------- PowerShell 小工具 ---------- */

function ps(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function setUserEnv(value) {
  const script =
    value === null
      ? `[Environment]::SetEnvironmentVariable('${ENV_NAME}', $null, 'User')`
      : `[Environment]::SetEnvironmentVariable('${ENV_NAME}', '${value}', 'User')`;
  ps(script);
}

function getUserEnv() {
  try {
    return ps(`[Environment]::GetEnvironmentVariable('${ENV_NAME}', 'User')`);
  } catch {
    return "";
  }
}

// 环境变量写进注册表后，已经跑着的 explorer.exe 还拿着旧环境块，
// 于是从任务栏启动的 WorkBuddy 读不到新变量。广播一次 WM_SETTINGCHANGE 让它刷新。
function broadcastEnvChange() {
  const parts = [
    "$sig='[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)]" +
      "public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint fuFlags,uint timeout,out UIntPtr result);'",
    "$t=Add-Type -MemberDefinition $sig -Name WBEnv -Namespace WBNative -PassThru",
    "$r=[UIntPtr]::Zero",
    "[void]$t::SendMessageTimeout([IntPtr]0xffff,0x001A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
  ];
  try {
    ps(parts.join(";"));
    return true;
  } catch {
    return false;
  }
}

/* ---------- 启动文件夹里的隐藏启动器 ---------- */

// VBS 内容保持纯 ASCII：Windows 脚本宿主默认按 ANSI 读 .vbs，带中文会乱码
// 拉起的是「监督进程」而不是守护进程本身：监督进程会保证守护进程一直活着，
// 这样用户只是重启 WorkBuddy（没注销）也不会出现「没有壁纸」。
function writeLauncher(nodeExe, port) {
  const inner = `"${nodeExe}" "${WATCHDOG}" --port ${port}`;
  const escaped = inner.replace(/"/g, '""');
  const content = [
    "' WorkBuddy Wallpaper Engine - silent autostart of the wallpaper watchdog.",
    "' Generated by scripts/autostart.mjs install. Delete this file to disable autostart.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${escaped}", 0, False`,
    "",
  ].join("\r\n");
  mkdirSync(startupDir(), { recursive: true });
  writeFileSync(VBS_PATH, content, "latin1");
}

function removeLauncher() {
  try {
    rmSync(VBS_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ---------- 守护进程 / 监督进程 ---------- */

function readPid(file) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const daemonPid = () => readPid(paths.pidPath);
const daemonAlive = () => pidAlive(daemonPid());
const watchdogPid = () => readPid(WATCHDOG_PID);
const watchdogAlive = () => pidAlive(watchdogPid());

function killPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

function startWatchdog(port) {
  const child = spawn(process.execPath, [WATCHDOG, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // 顺手把变量塞进环境，便于它派生出的守护进程继承
    env: { ...process.env, [ENV_NAME]: String(port) },
  });
  child.unref();
  return child.pid;
}

async function cdpReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const list = await response.json();
    return Array.isArray(list) && list.some((t) => String(t.url || "").includes("app.asar"));
  } catch {
    return false;
  }
}

/* ---------- 三个命令 ---------- */

async function install() {
  assertWindows();
  if (!existsSync(CLI)) throw new Error(`找不到 ${CLI}`);

  const nodeExe = process.execPath;

  // 1) 持久化环境变量
  setUserEnv(PORT);
  const broadcasted = broadcastEnvChange();

  // 2) 登录自启
  writeLauncher(nodeExe, PORT);

  // 2b) 把调试参数写进 WorkBuddy 的快捷方式（立刻生效，不等注销）
  const shortcuts = patchShortcuts(PORT);

  // 3) 立刻拉起监督进程（它自己会把守护进程带起来），不用等下次登录
  killPid(watchdogPid());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pid = startWatchdog(PORT);

  // 4) 记账，方便 uninstall / status
  mkdirSync(paths.installRoot, { recursive: true });
  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      { envName: ENV_NAME, port: PORT, nodeExe, watchdog: WATCHDOG, cli: CLI, vbsPath: VBS_PATH, installedAt: Date.now() },
      null,
      2,
    ),
    "utf8",
  );

  // 监督进程是异步起来的，稍等一下再读守护进程状态，报告更真实
  await new Promise((resolve) => setTimeout(resolve, 1200));

  return {
    envName: ENV_NAME,
    envValue: String(PORT),
    broadcasted,
    vbsPath: VBS_PATH,
    shortcuts,
    watchdogPid: pid,
    daemonPid: daemonPid(),
    nodeExe,
  };
}

async function uninstall() {
  assertWindows();

  const removedLauncher = removeLauncher();
  setUserEnv(null);
  broadcastEnvChange();
  const shortcuts = patchShortcuts(PORT, { remove: true });

  // 先停监督进程（否则它会把守护进程再拉起来），再摘注入、杀守护进程
  const killedWatchdog = killPid(watchdogPid());
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    execFileSync(process.execPath, [CLI, "stop", "--port", String(PORT)], {
      stdio: "ignore",
      timeout: 15000,
    });
  } catch {
    // CDP 不在就算了，下面直接杀进程
  }
  const killedDaemon = killPid(daemonPid());
  try {
    rmSync(STATE_PATH, { force: true });
    rmSync(WATCHDOG_PID, { force: true });
  } catch {
    // 忽略
  }

  return { removedLauncher, removedEnv: true, shortcuts, killedWatchdog, killedDaemon };
}

// 读回快捷方式的目标与启动参数（status 用）
function readShortcuts() {
  const out = [];
  for (const path of SHORTCUT_CANDIDATES) {
    if (!existsSync(path)) continue;
    const q = path.replace(/'/g, "''");
    const script = [
      "$sh = New-Object -ComObject WScript.Shell",
      `$lnk = $sh.CreateShortcut('${q}')`,
      "Write-Output $lnk.TargetPath",
      "Write-Output $lnk.Arguments",
    ].join("; ");
    try {
      const lines = ps(script).split(/\r?\n/);
      out.push({ path, target: (lines[0] || "").trim(), args: (lines[1] || "").trim() });
    } catch (error) {
      out.push({ path, error: error.message });
    }
  }
  return out;
}

async function status() {
  const persisted = getUserEnv();
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : null;
  return {
    platform: process.platform,
    envName: ENV_NAME,
    envPersisted: persisted || null,
    envExpected: String(PORT),
    launcherPath: VBS_PATH,
    launcherInstalled: existsSync(VBS_PATH),
    shortcuts: readShortcuts(),
    watchdogPid: watchdogPid(),
    watchdogAlive: watchdogAlive(),
    daemonPid: daemonPid(),
    daemonAlive: daemonAlive(),
    cdpReady: await cdpReady(PORT),
    state,
  };
}

/* ---------- 输出 ---------- */

function shortcutStatusText(status) {
  if (status === "PATCHED") return "已写入调试参数";
  if (status === "ALREADY") return "已有调试参数";
  if (status === "SKIP") return "跳过（不是 WorkBuddy 主程序）";
  if (status === "REVERTED") return "已还原";
  return status;
}

function report(title, lines) {  process.stdout.write(`\n${title}\n`);
  process.stdout.write("=".repeat(Math.max(title.length, 40)) + "\n");
  for (const line of lines) process.stdout.write(line + "\n");
  process.stdout.write("\n");
}

(async () => {
  try {
    if (command === "install") {
      const r = await install();
      report(`[${PRODUCT_NAME}] 已开启「打开 WorkBuddy 自动有壁纸」`, [
        `  环境变量   ${r.envName}=${r.envValue}   (用户级，永久生效)`,
        `  登录自启   ${r.vbsPath}`,
        ...r.shortcuts.map((s) => `  快捷方式   ${shortcutStatusText(s.status)}  ${basename(s.path)}`),
        `  监督进程   pid=${r.watchdogPid}   (常驻，守护进程掉了会自动补起来)`,
        `  守护进程   ${r.daemonPid ? `pid=${r.daemonPid}` : "启动中（约 1 秒后再查一次状态）"}`,
        "",
        `  以后无论怎么打开 / 重启 WorkBuddy，壁纸都会自动出现。`,
        "",
        `  接下来这样做（立刻生效，不用注销、不用重启电脑）：`,
        `    1) 关掉当前 WorkBuddy`,
        `    2) 从「桌面」或「开始菜单」的 WorkBuddy 快捷方式重新打开它`,
        `       （调试参数已写进快捷方式，所以这次一定会带上调试端口）`,
        "",
        `  如果你习惯用别的方式启动 WorkBuddy（不是这两个快捷方式），`,
        `  那还需要注销/重启一次系统，让环境变量对所有程序生效。`,
        "",
        `  取消：双击 uninstall-autostart.bat`,
      ]);
      return;
    }

    if (command === "uninstall") {
      const r = await uninstall();
      report(`[${PRODUCT_NAME}] 已关闭自启`, [
        `  启动项     ${r.removedLauncher ? "已删除" : "本来就没有"}`,
        `  环境变量   已清除 ${ENV_NAME}`,
        ...r.shortcuts.map((s) => `  快捷方式   ${shortcutStatusText(s.status)}  ${basename(s.path)}`),
        `  监督进程   ${r.killedWatchdog ? "已结束" : "本来就没跑"}`,
        `  守护进程   ${r.killedDaemon ? "已结束" : "本来就没跑"}`,
        "",
        `  WorkBuddy 已恢复原生外观。`,
      ]);
      return;
    }

    if (command === "status") {
      const s = await status();
      report(`[${PRODUCT_NAME}] 自启状态`, [
        `  环境变量   ${s.envName} = ${s.envPersisted ?? "(未设置)"}   期望 ${s.envExpected}`,
        `  登录自启   ${s.launcherInstalled ? "已安装" : "未安装"}  ${s.launcherPath}`,
        ...s.shortcuts.map((c) =>
          c.error
            ? `  快捷方式   读取失败  ${basename(c.path)}`
            : `  快捷方式   ${c.args.includes("remote-debugging-port") ? "已带调试参数" : "没有调试参数"}  ${basename(c.path)}`,
        ),
        `  监督进程   ${s.watchdogAlive ? `运行中 pid=${s.watchdogPid}` : "未运行"}`,
        `  守护进程   ${s.daemonAlive ? `运行中 pid=${s.daemonPid}` : "未运行"}`,
        `  CDP        ${s.cdpReady ? "就绪" : "未就绪（WorkBuddy 未带调试端口运行）"}`,
        "",
        s.launcherInstalled && s.envPersisted
          ? `  自启已开启：打开 WorkBuddy 会自动带壁纸。`
          : `  自启未开启。双击 install-autostart.bat 一键开启。`,
        s.launcherInstalled && s.envPersisted && !s.daemonAlive
          ? `\n  提示：监督进程没在跑，双击 install-autostart.bat 即可恢复。`
          : "",
      ]);
      return;
    }

    process.stdout.write(`未知命令：${command}\n用法：node scripts/autostart.mjs install|uninstall|status [--port 9223]\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`\n[错误] ${error.message}\n`);
    process.exitCode = 1;
  }
})();
