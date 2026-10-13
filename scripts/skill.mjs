#!/usr/bin/env node
// 把本包安装为 WorkBuddy 技能：复制到 ~/.workbuddy-ai/skills/<name>/。
//
// 为什么需要这一步：SKILL.md 只有落在技能目录里，WorkBuddy 才会把它当技能加载，
// 用户也才能直接对 AI 说「换个壁纸」。否则它就只是一堆需要手动敲的脚本。
//
// 用法：
//   node scripts/skill.mjs install      # 装成技能
//   node scripts/skill.mjs uninstall    # 移除技能
//   node scripts/skill.mjs status       # 看装没装
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SKILL_NAME = "workbuddy-wallpaper-engine";

// 复制时排除的东西：依赖、仓库元数据、运行产物
const EXCLUDE = /(^|[\\/])(node_modules|\.git|\.vscode|\.idea|\.tmp)([\\/]|$)|\.log$|\.zip$/i;

function skillsRoot() {
  // 新版是 .workbuddy-ai，老版本可能只有 .workbuddy；按存在的那个来
  const modern = join(homedir(), ".workbuddy-ai", "skills");
  const legacy = join(homedir(), ".workbuddy", "skills");
  if (existsSync(join(homedir(), ".workbuddy-ai"))) return modern;
  if (existsSync(join(homedir(), ".workbuddy"))) return legacy;
  return modern;
}

const DEST = join(skillsRoot(), SKILL_NAME);

function report(title, lines) {
  console.log("");
  console.log(`[WorkBuddy Wallpaper Engine] ${title}`);
  console.log("=".repeat(52));
  for (const line of lines) console.log(line);
  console.log("");
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function install() {
  if (ROOT === DEST) {
    return { alreadyInPlace: true, dest: DEST };
  }
  mkdirSync(DEST, { recursive: true });
  cpSync(ROOT, DEST, {
    recursive: true,
    force: true,
    filter: (src) => {
      if (src === ROOT) return true;
      return !EXCLUDE.test(relative(ROOT, src));
    },
  });
  return { alreadyInPlace: false, dest: DEST, files: countFiles(DEST) };
}

function uninstall() {
  if (!existsSync(DEST)) return { removed: false, dest: DEST };
  if (ROOT === DEST) return { removed: false, dest: DEST, self: true };
  rmSync(DEST, { recursive: true, force: true });
  return { removed: true, dest: DEST };
}

function status() {
  const installed = existsSync(DEST) && existsSync(join(DEST, "SKILL.md"));
  return {
    installed,
    dest: DEST,
    files: installed ? countFiles(DEST) : 0,
    inRepo: existsSync(join(ROOT, "SKILL.md")),
    same: ROOT === DEST,
  };
}

const command = process.argv[2] || "status";

if (command === "install") {
  const r = install();
  report("已安装为 WorkBuddy 技能", [
    `  技能目录   ${r.dest}`,
    r.alreadyInPlace
      ? `  状态       本包就在这里，无需复制`
      : `  已复制     ${r.files} 个文件`,
    "",
    `  WorkBuddy 里现在可以直接说「换个壁纸」「把视频当壁纸」了。`,
    "",
    `  想让壁纸在每次打开 WorkBuddy 时自动出现，再跑一次：`,
    `    install-autostart.bat`,
    "",
    `  移除：uninstall-skill.bat`,
  ]);
} else if (command === "uninstall") {
  const r = uninstall();
  report("已移除 WorkBuddy 技能", [
    `  技能目录   ${r.dest}`,
    r.self
      ? `  跳过       本包就装在技能目录里，删它会删掉源码；请手动处理`
      : r.removed
        ? `  已删除`
        : `  本来就没装`,
    "",
    `  注意：这不会关闭开机自启。要彻底还原请跑 uninstall-autostart.bat`,
  ]);
} else if (command === "status") {
  const s = status();
  report("技能安装状态", [
    `  技能目录   ${s.dest}`,
    `  是否已装   ${s.installed ? `已安装（${s.files} 个文件）` : "未安装"}`,
    s.same ? `  备注       当前就在技能目录里运行` : "",
    "",
    s.installed ? `  移除：uninstall-skill.bat` : `  安装：install-skill.bat`,
  ]);
} else {
  console.error(`未知命令：${command}`);
  console.error("可用：install | uninstall | status");
  process.exit(1);
}
