#!/usr/bin/env node
// 发新版本：改版本号 → 重新打包 → 打印后续 git 命令。
//
// 刻意**不自动提交 / 不自动推送**：那一步会对外发布，留给你自己确认。
//
// 用法：
//   node scripts/release.mjs 1.1.0                     # 发 1.1.0
//   node scripts/release.mjs 1.1.0 --dry-run           # 只看会做什么，不改任何文件
//   node scripts/release.mjs 1.1.0 --notes "修了缩略图黑帧"   # 顺手在 CHANGELOG 插一节
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./zip.mjs";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const NAME = "workbuddy-wallpaper-engine";
const DIST = resolve(ROOT, ".."); // 打好的 zip 放仓库外，免得被 git 跟踪
const PKG = join(ROOT, "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const notesIndex = argv.indexOf("--notes");
const notes = notesIndex >= 0 ? argv[notesIndex + 1] || "" : "";
// 取第一个「不是选项、也不是 --notes 的值」的参数当版本号。
// 注意必须带 notesIndex >= 0 的判断：没有 --notes 时 notesIndex 是 -1，
// notesIndex + 1 恰好是 0，会把版本号本身排除掉。
const version = argv.find((a, i) => !a.startsWith("--") && !(notesIndex >= 0 && i === notesIndex + 1));

function out(line = "") {
  console.log(line);
}

function fail(message) {
  out(`\n[错误] ${message}\n`);
  process.exit(1);
}

if (!version) {
  fail("缺少版本号。用法：node scripts/release.mjs 1.1.0 [--dry-run] [--notes \"...\"]");
}

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  fail(`版本号格式不对：${version}（应为 1.1.0 这种语义化版本）`);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version;

function compare(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

if (compare(version, current) <= 0) {
  fail(`新版本 ${version} 不比当前 ${current} 大。发版号只能往上走。`);
}

out("");
out(`[${NAME}] 发版准备：${current} → ${version}${dryRun ? "   （dry-run，不改文件）" : ""}`);
out("=".repeat(56));

// 1) package.json 版本号
if (!dryRun) {
  pkg.version = version;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}
out(`  ① package.json          ${dryRun ? "将改为" : "已改为"} ${version}`);

// 2) CHANGELOG 插一节（给了 --notes 才做）
if (notes) {
  const text = readFileSync(CHANGELOG, "utf8");
  const marker = "\n## [";
  const at = text.indexOf(marker);
  const today = new Date().toISOString().slice(0, 10);
  const section = `\n## [${version}] - ${today}\n\n### 变更\n\n- ${notes}\n`;
  const next = at >= 0 ? text.slice(0, at) + section + text.slice(at) : text + section;
  if (!dryRun) writeFileSync(CHANGELOG, next, "utf8");
  out(`  ② CHANGELOG.md          ${dryRun ? "将插入" : "已插入"} [${version}] 一节`);
} else {
  out(`  ② CHANGELOG.md          跳过（没给 --notes，记得自己补一节）`);
}

// 打包：用自带的纯 Node 打包器（scripts/zip.mjs），不调任何外部程序。
// 早先版本调 tar / PowerShell，结果在受限环境里 spawn 会被拦（EBUSY），
// 而且「有没有 tar」和「能不能执行」是两件事，回退链也救不了。
//
// 必须排除 .git —— 否则发布包里会混进整个仓库历史（实测 33 个源码文件
// 会变成 95 个），既臃肿又没必要。
const ZIP_EXCLUDE = /(^|\/)(node_modules|\.git|\.vscode|\.idea|\.tmp|dist)(\/|$)|\.log$|\.zip$/i;

function buildZip() {
  const target = join(DIST, `${NAME}-${version}.zip`);
  if (existsSync(target)) rmSync(target, { force: true });
  return zipDirectory(ROOT, target, NAME, { exclude: ZIP_EXCLUDE });
}

const zipPath = join(DIST, `${NAME}-${version}.zip`);
if (dryRun) {
  out(`  ③ 发布包               将生成 ${zipPath}`);
} else {
  try {
    const info = buildZip();
    out(`  ③ 发布包               已生成 ${zipPath}  (${info.files} 个文件, ${Math.round(info.bytes / 1024)} KB)`);
  } catch (error) {
    out(`  ③ 发布包               打包失败：${error.message}`);
    out(`                          可手动压缩 ${ROOT} 后放到 ${zipPath}`);
  }
}

// 4) 下一步
out("");
out("  接下来手动执行（对外发布，脚本不代劳）：");
out("");
out(`    cd ${ROOT}`);
out(`    git add -A`);
out(`    git commit -m "release: v${version}"`);
out(`    git tag -a v${version} -m "v${version}"`);
out(`    git push origin main`);
out(`    git push origin v${version}`);
out("");
out("  然后去 GitHub 建 Release：");
out(`    https://github.com/AustinElite/${NAME}/releases/new`);
out(`    · Tag 选 v${version}`);
out(`    · 标题填 ${NAME} v${version}`);
out(`    · 把 ${zipPath} 拖进附件区`);
out(`    · 点 Publish release`);
out("");
out("  别忘了（脚本管不到的）：");
out("    · install-skill.bat —— 把新版本同步进技能目录");
out("    · SKILL.md —— 有行为变化时更新描述");
out("");
