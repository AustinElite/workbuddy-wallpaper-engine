# 发版清单

给维护者看。发新版本时照着走一遍，避免漏步骤。

---

## 版本号怎么定

语义化版本 `主版本.次版本.修订号`：

| 改了什么 | 该发 | 例子 |
|---|---|---|
| 修 bug、不改变行为 | 修订号 +1 | `1.0.0` → `1.0.1` |
| 加新功能，向后兼容 | 次版本 +1，修订归零 | `1.0.0` → `1.1.0` |
| 破坏性变更（配置格式变了、要求新版 WorkBuddy） | 主版本 +1 | `1.0.0` → `2.0.0` |

对号入座的例子：

- 修「视频缩略图停在黑帧」→ `1.0.1`
- 加「Scene 场景壁纸」「视频倍速」→ `1.1.0`
- 改 `config.json` 结构且不兼容旧版 → `2.0.0`

---

## 方式一：用脚本（推荐）

```bash
node scripts/release.mjs 1.1.0
```

它做三件事：

1. 把 `package.json` 的 `version` 改成新号
2. 在 `CHANGELOG.md` 顶部插一节（给了 `--notes` 才做）
3. 重新打包出 `../workbuddy-wallpaper-engine-1.1.0.zip`

**然后它会把后续 git 命令打印出来，但不会替你执行** —— 推送是对外发布，留给你确认。

常用参数：

```bash
node scripts/release.mjs 1.1.0 --dry-run                  # 只看会做什么，不动文件
node scripts/release.mjs 1.1.0 --notes "新增：视频倍速"    # 顺手写 CHANGELOG
```

脚本会拦下三种错误：版本号格式不对、新号不比旧号大、没给版本号。

### 关于打包

打包用的是自带的 `scripts/zip.mjs`（纯 Node，只用内置 zlib），**不调 tar / PowerShell**。

为什么自己写：调用外部程序会受沙箱、PATH、杀软、系统版本影响，出问题时很难解释；
而且「系统里有没有 tar」和「能不能执行成功」是两件事，光做存在性判断的回退链救不了。
自己写反而更短、更可控，也能自动化验证（`unzip -t` 校验通过）。

打包时会排除 `.git` / `node_modules` / `*.log` / `*.zip` —— **不加这个排除，
发布包里会混进整个仓库历史**（实测 33 个源码文件会变成 95 个）。

---

## 方式二：手动

不用脚本，一步步来。

### ① 改 `package.json`

```diff
-  "version": "1.0.0",
+  "version": "1.1.0",
```

### ② 改 `CHANGELOG.md`

在文件开头的说明段和 `## [1.0.0]` 之间**插入新的一节**（最新的在最上面）：

```markdown
## [1.1.0] - 2026-10-14

### 新增

- 视频倍速与翻转

### 修复

- 缩略图停在第一帧导致看起来是黑块
```

### ③ 打包（可选）

> **最省事的做法：跳过这一步。** GitHub 会自动为每个 Release 生成
> `Source code (zip)` / `Source code (tar.gz)`，命名就是
> `workbuddy-wallpaper-engine-1.1.0.zip`，和手打的完全一致，
> 而且**自动排除 `.git`**。本项目"解压后双击 bat"就能用，源码包足够。

想自己打一个的话（**必须排除 `.git`**，否则 34 个源码文件会变成 96 个）：

```cmd
cd /d E:\WorkBuddy
tar --format=zip -cf workbuddy-wallpaper-engine-1.1.0.zip --exclude="workbuddy-wallpaper-engine/.git" workbuddy-wallpaper-engine
```

Git Bash 里把 `tar` 写成 `/c/Windows/System32/tar.exe` 也一样。

打完核对一下：

```cmd
tar -tf workbuddy-wallpaper-engine-1.1.0.zip | findstr /C:".git/"
```

**没有任何输出**才是对的。

### ④ 自检

```bash
npm run check
node src/cli.mjs status
```

### ⑤ 提交并打 tag

见下面「完整清单」的 ③。

---

## 完整清单

### ① 发版前

- [ ] 代码改完，**已实测过**（不是"应该没问题"）
- [ ] `node --check` 全部通过 —— 或直接跑 `npm run check`
- [ ] 有行为变化的话，`SKILL.md` 的描述同步更新
- [ ] 有行为变化的话，`README.md` 的特性 / FAQ 同步更新
- [ ] **`install-skill.bat`** —— 把新版本同步进技能目录（这一步脚本管不到）

### ② 准备发布

- [ ] `node scripts/release.mjs <新版本号> --notes "一句话说明"`
- [ ] 检查 `package.json` 版本号、`CHANGELOG.md` 新节、生成的 zip

### ③ 提交并打 tag

```bash
git add -A
git commit -m "release: v1.1.0"
git tag -a v1.1.0 -m "v1.1.0"
git push origin main
git push origin v1.1.0
```

> tag 一定要打在**已经提交**的 commit 上。先 tag 再 commit，tag 会指向旧提交。

### ④ 建 Release

打开 `https://github.com/AustinElite/workbuddy-wallpaper-engine/releases/new`

- [ ] **Tag** 选刚推的 `v1.1.0`（下拉里选已有的，**不要**选 "Create new tag"）
- [ ] **Release title** 填 `workbuddy-wallpaper-engine v1.1.0`
- [ ] **Describe this release** 写更新说明（可直接抄 CHANGELOG 那一节）
- [ ] **Attach binaries** 把 zip 拖进**附件区的虚线框**
      （⚠️ 别拖到上面的正文编辑框 —— 那样 GitHub 会在描述里插一行链接，
      和附件重复，看起来像笔误）
- [ ] **Release label** 保持 `None`（除非是预发布版）
- [ ] **Publish release**（按钮在页面最底部）

### ⑤ 发布后

- [ ] 刷新仓库首页，确认右侧 Releases 区块出现新版本
- [ ] 点一下附件，确认能下载
- [ ] 需要的话更新仓库 **About** 里的描述

---

## 出问题怎么办

**推送被拒 `Connection was reset`**
GitHub 在这台机器上是直连不通的，已配置走本地代理：

```bash
git config --global --get "http.https://github.com.proxy"
# 应该输出 http://127.0.0.1:7897
```

代理（Clash）没开的话，GitHub 相关操作都会失败；其它仓库不受影响。

**`src refspec main does not match any`**
`git init` 时默认分支是 `master`。确认并改名：

```bash
git branch          # 看当前分支
git branch -M main
```

**打包出来的 zip 里混进了 `.git`**
检查 `release.mjs` 里的 `ZIP_EXCLUDE` 是否被改动过。

**忘了改版本号就打了 tag**
删掉重来（远程 tag 也要删）：

```bash
git tag -d v1.1.0
git push origin :refs/tags/v1.1.0
```
