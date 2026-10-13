(() => {
  const NS = (window.__wbWe = window.__wbWe || {});
  NS.queue = NS.queue || [];
  NS.open = NS.open === true;
  NS.mediaId = NS.mediaId === undefined ? null : NS.mediaId;
  NS.onBattery = NS.onBattery === true;
  NS.hostState = __WBWE_STATE__;

  const STYLE_ID = "wb-we-style";
  const MEDIA_ID = "wb-we-media";
  const FAB_ID = "wb-we-fab";
  const PANEL_ID = "wb-we-panel";
  // 注入脚本版本。早期版本把监听器直接挂在元素上且没留存引用，
  // 无法用 removeEventListener 摘除；版本变化时直接重建节点清空。
  const SCRIPT_VERSION = 4;

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (ch) =>
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
    );

  // 需要「即时响应」的动作（要碰宿主文件系统，本地没法给反馈）
  const INSTANT_ACTIONS = { openFolder: true, rescan: true };

  const push = (action) => {
    // 队列永远是兜底：守护进程没跑、或绑定还没注册时靠它。
    NS.queue.push(action);
    // 直达通道：守护进程通过 Runtime.addBinding 注入了 window.__wbWeAction，
    // 调用它会立刻在宿主侧触发事件，不用等下一轮 900ms 轮询。
    // 只有 openFolder / rescan 走这条路（宿主侧对副作用动作做了时间窗去重，
    // 队列里的同一份会被丢掉，不会重复开窗）。
    if (!action || !INSTANT_ACTIONS[action.type]) return;
    try {
      if (typeof window.__wbWeAction === "function") {
        window.__wbWeAction(JSON.stringify(action));
      }
    } catch {
      // 绑定不可用（版本差异等）→ 静默回退到队列轮询
    }
  };

  /* ---------- 宿主在线检测 ----------
     守护进程每轮取队列时都会刷新 NS.lastBeat（见 ui.mjs 的 buildQueueDrain）。
     「打开文件夹 / 重新扫描」这类动作只有宿主能做，守护进程没跑时点了会石沉大海——
     必须明确告诉用户，不能让他以为是「慢」。 */
  const HOST_BEAT_TIMEOUT_MS = 3000;

  // WorkBuddy 的「设置」是一个**独立渲染窗口**，body 上带 settings-window 类。
  // 壁纸/玻璃注入进去是合理的（设置窗口也有壁纸），但很多"只该在主窗口做"的事
  // 必须靠它区分开 —— 比如放浮动按钮、按焦点判断是否暂停播放。
  // 双判据：类名 + 结构锚点（.settings-window-root），任一中就认。
  function isSettingsWindow() {
    return (
      document.body.classList.contains("settings-window") ||
      Boolean(document.querySelector(".settings-window-root"))
    );
  }

  function hostAlive() {
    return typeof NS.lastBeat === "number" && Date.now() - NS.lastBeat < HOST_BEAT_TIMEOUT_MS;
  }

  function ackHostAction(node) {
    if (!node || typeof node.textContent !== "string") return;
    const prev = node.textContent;
    const ok = hostAlive();
    node.textContent = ok ? "处理中…" : "引擎未运行";
    node.classList.add(ok ? "is-busy" : "is-error");
    if (!ok) {
      node.title = "壁纸引擎守护进程没在跑。双击 workbuddy-wallpaper-engine 目录下的 install-autostart.bat 就能修好。";
    }
    setTimeout(() => {
      node.textContent = prev;
      node.classList.remove("is-busy", "is-error");
    }, ok ? 900 : 2400);
  }

  /* ---------- 本地状态 ----------
     面板不依赖守护进程也能工作：改动立刻在页面生效并写入 localStorage。
     守护进程（若在跑）会消费队列把同样的改动落到 config.json。
     两边都记了时间戳，注入时谁新用谁，避免互相覆盖。 */
  const LS_KEY = "workbuddy-wallpaper-engine:state";

  // WorkBuddy 渲染进程是 file:// 源，localStorage 可能直接抛异常，
  // 所以内存副本才是主存储，localStorage 只是能写就写。
  function readLocal() {
    if (NS.localMemory) return NS.localMemory;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.values) {
        NS.localMemory = parsed;
        return parsed;
      }
    } catch {
      // file:// 源下不可用
    }
    return null;
  }

  function writeLocal(values, updatedAt) {
    const record = { values: values, updatedAt: updatedAt };
    NS.localMemory = record;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(record));
    } catch {
      // 写不进去就只靠内存副本，本次会话内依然有效
    }
  }

  function paletteFor(schemeId) {
    const list = NS.hostState.schemes || [];
    const scheme = list.find((item) => item.id === schemeId) || list[0];
    if (!scheme) return NS.hostState.palette;
    return { id: scheme.id, label: scheme.label, accent: scheme.accent, surface: scheme.surface, text: scheme.text };
  }

  function resolveState() {
    const host = NS.hostState;
    const local = readLocal();
    NS.local = local;

    if (!local || (local.updatedAt || 0) <= (host.hostUpdatedAt || 0)) {
      NS.state = Object.assign({}, host);
      return;
    }

    const v = local.values || {};
    const items = host.items || [];
    const activeId = v.activeId === undefined ? (host.active ? host.active.id : null) : v.activeId;
    NS.state = Object.assign({}, host, {
      glass: typeof v.glass === "number" ? v.glass : host.glass,
      brightness: typeof v.brightness === "number" ? v.brightness : host.brightness,
      saturation: typeof v.saturation === "number" ? v.saturation : host.saturation,
      fit: v.fit || host.fit,
      pauseOnBlur: typeof v.pauseOnBlur === "boolean" ? v.pauseOnBlur : host.pauseOnBlur,
      pauseOnBattery: typeof v.pauseOnBattery === "boolean" ? v.pauseOnBattery : host.pauseOnBattery,
      palette: paletteFor(v.scheme || host.palette.id),
      active: items.find((item) => item.id === activeId) || null,
    });
  }

  function commitLocal(patch) {
    const prev = (NS.local && NS.local.values) || {};
    const values = Object.assign({}, prev, patch);
    const updatedAt = Date.now();
    NS.local = { values: values, updatedAt: updatedAt };
    writeLocal(values, updatedAt);
  }

  // 本地改完后重新套用全部效果
  function refresh() {
    resolveState();
    applyCss();
    applyMedia();
    renderPanel();
    if (NS.settingsOpen) renderSettings();
    applyFabPosition();
    applyPanelPosition();
    syncPlayback();
  }

  const pct = (value) => String(Math.round(Math.max(0, Math.min(1, value)) * 100));
  const mix = (hex, alpha) => "color-mix(in srgb, " + hex + " " + pct(alpha) + "%, transparent)";

  function luminance(hex) {
    const value = parseInt(String(hex).replace("#", "").slice(0, 6), 16);
    if (!Number.isFinite(value)) return 0;
    return (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
  }

  function titleForeground(hex) {
    return luminance(hex) > 0.6 ? "#101828" : "#ffffff";
  }

  // 壁纸可能是亮也可能是暗，文字投影取反色保证任何底图上都读得清
  function textShadowFor(surfaceHex) {
    return luminance(surfaceHex) > 0.5
      ? "0 1px 3px rgba(255, 255, 255, 0.85), 0 0 10px rgba(255, 255, 255, 0.55)"
      : "0 1px 3px rgba(0, 0, 0, 0.65), 0 0 10px rgba(0, 0, 0, 0.4)";
  }

  function ensureStyle(id) {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    return style;
  }

  function applyCss() {
    const state = NS.state;

    // 面板样式常驻，保证未选壁纸时也能打开选择器
    ensureStyle("wb-we-panel-style").textContent = state.panelCss;

    // 壁纸样式只在选中壁纸时注入，否则整块移除，WorkBuddy 保持原生外观
    const existing = document.getElementById("wb-we-skin-style");
    if (!state.active) {
      if (existing) existing.remove();
      return;
    }

    const palette = state.palette;
    const base = (100 - state.glass) / 100;
    const panelAlpha = Math.min(1, base + 0.06);
    const glassAlpha = Math.max(base, 0.55);
    // 右侧面板用更透的一档：玻璃透明度拉满时也要能看清壁纸
    const rightGlassAlpha = Math.max(base - 0.05, 0.32);
    // 浮层 / 卡片（下拉、弹窗、气泡、表格、分享栏）用更透的一档，配 backdrop-filter 做磨砂
    const popoverAlpha = Math.max(base - 0.08, 0.32);
    const topbarAlpha = Math.max(base - 0.25, 0.35);
    const scrimAlpha = Math.max(base - 0.45, 0.15);
    const blur = Math.round(8 + state.glass * 0.5);

    ensureStyle("wb-we-skin-style").textContent = state.skinCssTemplate
      .split("__ACCENT__").join(palette.accent)
      .split("__SURFACE__").join(palette.surface)
      .split("__TEXT__").join(palette.text)
      .split("__TITLE_FG__").join(titleForeground(palette.accent))
      .split("__TEXT_SHADOW__").join(textShadowFor(palette.surface))
      .split("__SURFACE_ALPHA__").join(mix(palette.surface, base))
      .split("__PANEL_ALPHA__").join(mix(palette.surface, panelAlpha))
      .split("__GLASS_BG__").join(mix(palette.surface, glassAlpha))
      .split("__RIGHTGLASS__").join(mix(palette.surface, rightGlassAlpha))
      .split("__POPOVER_BG__").join(mix(palette.surface, popoverAlpha))
      .split("__TOPBAR_BG__").join(mix(palette.surface, topbarAlpha))
      .split("__SCRIM__").join(mix(palette.surface, scrimAlpha))
      .split("__BLUR__").join(String(blur));
  }

  function ensureMediaHost() {
    let host = document.getElementById(MEDIA_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = MEDIA_ID;
      document.body.insertBefore(host, document.body.firstChild);
    }
    return host;
  }

  // 壁纸图层淡入。
  // 为什么需要：直接出现会「啪」地闪一下 —— 主窗口启动时壁纸层建得比界面早，
  // 中间有一段只有壁纸。淡入让这个过渡平顺，不再像"闪"。
  function revealMediaWhenReady(host) {
    if (!host) return;
    host.style.transition = "opacity 420ms ease";
    host.style.opacity = "0";
    // 两帧后再翻到 1：确保 opacity:0 已经渲染过一次，过渡才会真正跑起来
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        host.style.opacity = "1";
      });
    });
  }

  function applyMedia() {
    const state = NS.state;
    const host = ensureMediaHost();
    const active = state.active;
    const key = active ? active.id : "";

    if (NS.mediaId !== key) {
      host.textContent = "";
      NS.mediaEl = null;
      if (active) {
        let element;
        if (active.kind === "video") {
          element = document.createElement("video");
          element.src = active.url;
          element.loop = true;
          element.muted = true;
          element.autoplay = true;
          element.playsInline = true;
          element.setAttribute("playsinline", "");
          element.setAttribute("disablepictureinpicture", "");
          element.addEventListener("loadeddata", syncPlayback);
        } else {
          element = document.createElement("img");
          element.src = active.url;
          element.decoding = "async";
          element.alt = "";
        }
        host.appendChild(element);
        NS.mediaEl = element;
        revealMediaWhenReady(host);
      }
      NS.mediaId = key;
    }

    if (NS.mediaEl) {
      NS.mediaEl.style.objectFit = state.fit;
      NS.mediaEl.style.filter =
        "brightness(" + state.brightness + "%) saturate(" + state.saturation + "%)";
    }
    host.classList.toggle("is-hidden", !active);
  }

  // 选一个"有内容"的时间点当静止帧。
  // 实测某个壁纸：0.2s 亮度 1（全黑）、1.06s 只有 12、3.5s 才到 48、5.5s 到 51。
  // 所以取**中段**而不是按比例取开头 —— 取开头常常落在黑场里，
  // 看起来就像"壁纸没加载出来"。
  function stillFrameTime(duration) {
    if (!Number.isFinite(duration) || duration <= 2) return 0.5;
    return Math.min(duration * 0.5, 10);
  }

  function syncPlayback() {
    const element = NS.mediaEl;
    if (!element || element.tagName !== "VIDEO") return;
    const state = NS.state;
    const blurred = state.pauseOnBlur && (document.hidden || !document.hasFocus());
    const onBattery = state.pauseOnBattery && NS.onBattery;
    if (blurred || onBattery) {
      if (!element.paused) element.pause();
    } else if (element.paused) {
      const played = element.play();
      if (played && played.catch) played.catch(() => {});
    }
  }

  function bindPlaybackListeners() {
    rebind(document, "visibilitychange", "hVisibility", syncPlayback);
    rebind(window, "blur", "hWindowBlur", syncPlayback);
    rebind(window, "focus", "hWindowFocus", syncPlayback);
    if (NS.batteryBound) return;
    NS.batteryBound = true;
    if (navigator.getBattery) {
      navigator
        .getBattery()
        .then((battery) => {
          NS.onBattery = !battery.charging;
          battery.addEventListener("chargingchange", () => {
            NS.onBattery = !battery.charging;
            if (NS.syncPlayback) NS.syncPlayback();
          });
          if (NS.syncPlayback) NS.syncPlayback();
        })
        .catch(() => {});
    }
  }

  const FIT_LABELS = { cover: "铺满", contain: "完整", fill: "拉伸" };

  // 视频缩略图默认停在第一帧，而不少片子第一帧接近全黑，看起来像"没加载出来"。
  // 统一往后 seek 一点点，让缩略图显示有内容的画面。
  function primeVideoThumbs(root) {
    if (!root) return;
    for (const video of root.querySelectorAll("video")) {
      if (video.dataset.wbwePrimed) continue;
      video.dataset.wbwePrimed = "1";
      const seek = () => {
        try {
          video.currentTime = stillFrameTime(video.duration);
        } catch {
          // 个别编码不支持 seek，保持原样即可
        }
      };
      if (video.readyState >= 1) seek();
      else video.addEventListener("loadedmetadata", seek, { once: true });
    }
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle("is-open", NS.open);
    if (!NS.open) {
      panel.innerHTML = "";
      applyPanelPosition();
      return;
    }

    const state = NS.state;
    const items = state.items || [];
    const activeId = state.active ? state.active.id : null;

    const tiles = items
      .map((item) => {
        const thumb =
          item.kind === "video"
            ? '<video src="' + esc(item.url) + '" muted preload="metadata"></video>'
            : '<img src="' + esc(item.url) + '" loading="lazy" alt="">';
        const badge =
          item.kind === "video" ? '<span class="wbwe-badge">动态</span>' : item.kind === "gif" ? '<span class="wbwe-badge">GIF</span>' : "";
        return (
          '<button class="wbwe-tile' + (item.id === activeId ? " is-active" : "") + '" data-wbwe="pick" data-value="' + esc(item.id) + '" title="' + esc(item.name) + " · " + esc(item.sizeText) + '">' +
          thumb + badge +
          '<span class="wbwe-tile-name">' + esc(item.name) + "</span>" +
          "</button>"
        );
      })
      .join("");

    panel.innerHTML =
      '<div class="wbwe-head"><span>壁纸引擎</span><button class="wbwe-x" data-wbwe="close" title="收起">×</button></div>' +
      '<div class="wbwe-body">' +
        '<div class="wbwe-sec">' +
          '<div class="wbwe-sec-title">壁纸<span class="wbwe-count">' + items.length + "</span>" +
            '<button class="wbwe-mini" data-wbwe="rescan">重新扫描</button>' +
            '<button class="wbwe-mini" data-wbwe="openFolder">打开文件夹</button>' +
          "</div>" +
          (items.length
            ? '<div class="wbwe-grid">' + tiles + "</div>"
            : '<p class="wbwe-empty">没找到壁纸。把 .mp4 / .webm / .gif / .jpg / .png 放进壁纸文件夹，或点「打开文件夹」。</p>') +
          '<button class="wbwe-wide" data-wbwe="clear">清除壁纸，恢复原生外观</button>' +
        "</div>" +
        '<div class="wbwe-sec">' +
          '<div class="wbwe-sec-title">液态玻璃</div>' +
          '<label class="wbwe-row"><span>玻璃透明度</span><b id="wbwe-glass-val">' + state.glass + "%</b></label>" +
          '<input id="wbwe-glass" type="range" min="0" max="60" step="1" value="' + state.glass + '">' +
          '<label class="wbwe-row"><span>亮度</span><b id="wbwe-bri-val">' + state.brightness + "%</b></label>" +
          '<input id="wbwe-bri" type="range" min="30" max="160" step="1" value="' + state.brightness + '">' +
          '<label class="wbwe-row"><span>饱和度</span><b id="wbwe-sat-val">' + state.saturation + "%</b></label>" +
          '<input id="wbwe-sat" type="range" min="0" max="200" step="1" value="' + state.saturation + '">' +
          '<div class="wbwe-sec-title">配色</div>' +
          '<div class="wbwe-schemes">' +
            state.schemes
              .map((scheme) =>
                '<button class="wbwe-scheme' + (state.palette.id === scheme.id ? " is-active" : "") + '" data-wbwe="scheme" data-value="' + esc(scheme.id) + '" style="--sw:' + esc(scheme.accent) + '"><i></i>' + esc(scheme.label) + "</button>",
              )
              .join("") +
          "</div>" +
          '<div class="wbwe-sec-title">适配方式</div>' +
          '<div class="wbwe-seg">' +
            state.fitModes
              .map((mode) =>
                '<button class="' + (state.fit === mode ? "is-active" : "") + '" data-wbwe="fit" data-value="' + mode + '">' + (FIT_LABELS[mode] || mode) + "</button>",
              )
              .join("") +
          "</div>" +
        "</div>" +
        '<div class="wbwe-sec">' +
          '<div class="wbwe-sec-title">省电</div>' +
          '<button class="wbwe-toggle' + (state.pauseOnBlur ? " is-on" : "") + '" data-wbwe="toggleBlur"><i></i>窗口失焦时暂停</button>' +
          '<button class="wbwe-toggle' + (state.pauseOnBattery ? " is-on" : "") + '" data-wbwe="toggleBattery"><i></i>电池供电时暂停</button>' +
        "</div>" +
      "</div>";

    // 必须在 innerHTML 之后定位：面板没内容时量到的尺寸是 0，会算错位置
    applyPanelPosition();

    const bindRange = (selector, valueSelector, key) => {
      const input = panel.querySelector(selector);
      const label = panel.querySelector(valueSelector);
      if (!input) return;
      input.addEventListener("input", () => {
        const value = Number(input.value);
        if (label) label.textContent = value + "%";
        NS.state[key] = value;
        if (key === "glass") applyCss();
        else applyMedia();
      });
      input.addEventListener("change", () => {
        const patch = {};
        patch[key] = Number(input.value);
        commitLocal(patch);
        push({ type: "set", patch: patch });
      });
    };
    bindRange("#wbwe-glass", "#wbwe-glass-val", "glass");
    bindRange("#wbwe-bri", "#wbwe-bri-val", "brightness");
    bindRange("#wbwe-sat", "#wbwe-sat-val", "saturation");
    primeVideoThumbs(panel);
  }

  function handlePanelAction(event) {
    const node = event.target.closest ? event.target.closest("[data-wbwe]") : null;
    if (!node) return;
    const action = node.getAttribute("data-wbwe");
    const value = node.getAttribute("data-value");
    const state = NS.state;

    if (action === "pick") {
      commitLocal({ activeId: value });
      push({ type: "setActive", id: value });
      refresh();
    } else if (action === "clear") {
      commitLocal({ activeId: null });
      push({ type: "setActive", id: null });
      refresh();
    } else if (action === "fit") {
      commitLocal({ fit: value });
      push({ type: "set", patch: { mode: value } });
      refresh();
    } else if (action === "scheme") {
      commitLocal({ scheme: value });
      push({ type: "set", patch: { scheme: value } });
      refresh();
    } else if (action === "toggleBlur") {
      const next = !state.pauseOnBlur;
      commitLocal({ pauseOnBlur: next });
      push({ type: "set", patch: { pauseOnBlur: next } });
      refresh();
    } else if (action === "toggleBattery") {
      const next = !state.pauseOnBattery;
      commitLocal({ pauseOnBattery: next });
      push({ type: "set", patch: { pauseOnBattery: next } });
      refresh();
    } else if (action === "rescan") {
      // 重扫需要读宿主文件系统，只能交给守护进程
      push({ type: "rescan" });
      ackHostAction(node);
    } else if (action === "openFolder") {
      push({ type: "openFolder" });
      ackHostAction(node);
    } else if (action === "close") {
      closePanel();
    }
  }

  function closePanel() {
    NS.open = false;
    renderPanel();
  }

  // FAB 位置：拖动过就用 left/top，否则回到默认的右下角
  function applyFabPosition() {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    const pos = NS.fabPos;
    if (pos) {
      fab.style.left = pos.x + "px";
      fab.style.top = pos.y + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    } else {
      fab.style.left = "";
      fab.style.top = "";
      fab.style.right = "";
      fab.style.bottom = "";
    }
  }

  // 面板位置：不可手动拖动，**始终**贴着 FAB 开在它旁边（无论 FAB 有没有被拖动过）。
  // 早先只在 NS.fabPos 有值（拖动过）时才跟随，FAB 停在默认右下角时面板就回落到
  // CSS 的 right/bottom，看起来"一直浮在屏幕右边"——这正是用户反馈的问题。
  function applyPanelPosition() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const fab = document.getElementById(FAB_ID);
    const pr = panel.getBoundingClientRect();
    const fr = fab ? fab.getBoundingClientRect() : null;
    if (fr && fr.width > 0 && pr.width > 0 && pr.height > 0) {
      // 优先贴在 FAB 左侧（并垂直居中），避免面板把自己的 FAB 盖住；
      // 左边放不下就放右侧。
      let x = fr.left - pr.width - 12;
      let y = fr.top + fr.height / 2 - pr.height / 2;
      if (x < 8) x = fr.right + 12;
      x = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x));
      y = Math.max(8, Math.min(window.innerHeight - pr.height - 8, y));
      panel.style.left = Math.round(x) + "px";
      panel.style.top = Math.round(y) + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      return;
    }

    // FAB 还没量到（首帧 / 被移除）→ 交回 CSS 的 right/bottom 兜底
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
  }

  // 每次注入都是新的闭包，旧监听器必须摘掉再挂新的，
  // 否则面板元素没变（NS.boundPanel === panel）就一直跑上一版的旧代码。
  function rebind(target, type, key, handler, options) {
    if (NS[key]) target.removeEventListener(type, NS[key], options);
    NS[key] = handler;
    target.addEventListener(type, handler, options);
  }

  // 面板不可拖动（按需求：只有 FAB 能移动），所以这里只绑点击。
  // 旧版本在面板上绑过拖动监听，靠 SCRIPT_VERSION 变化重建节点清掉。
  function bindPanelElement() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    rebind(panel, "click", "hPanelClick", handlePanelAction);
  }

  // 点击页面其它地方收起面板
  function bindDismiss() {
    rebind(
      document,
      "pointerdown",
      "hDismiss",
      (event) => {
        if (!NS.open) return;
        const panel = document.getElementById(PANEL_ID);
        const fab = document.getElementById(FAB_ID);
        const target = event.target;
        if (panel && panel.contains(target)) return;
        if (fab && fab.contains(target)) return;
        closePanel();
      },
      true,
    );
  }

  // 把设置窗口恢复成**原生状态**：摘掉我们注入的一切
  //（浮动按钮、选择器面板、壁纸层、壁纸样式、面板样式）。
  //
  // 为什么设置窗口不做玻璃：实测它自己的界面要 ~1.8 秒才渲染出来，
  // 这段空白填壁纸也不舒服、留白也不舒服；而且用户在那里是来改设置的，
  // 原生外观最不容易出问题。**保持原生是这个窗口上最省心的选择。**
  function restoreSettingsWindow() {
    for (const id of [FAB_ID, PANEL_ID, MEDIA_ID, "wb-we-skin-style", "wb-we-panel-style"]) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
    document.documentElement.classList.remove("wb-we-settings-open");
    NS.mediaEl = null;
    NS.mediaId = null;
  }

  // 设置窗口的 body 类**可能在注入之后**才被加上 —— 实测「新开设置窗口」就是这样：
  // 注入那一刻 body 上还没有 settings-window，我们就按主窗口把壁纸/按钮都建好了，
  // 而之后没人再来清理。所以盯一下 body 的 class，一旦变成设置窗口就立刻还原。
  function watchSettingsWindow() {
    if (NS.settingsWinObserver || !document.body) return;
    NS.settingsWinObserver = new MutationObserver(() => {
      if (!isSettingsWindow()) return;
      restoreSettingsWindow();
    });
    NS.settingsWinObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  function ensureChrome() {
    if (isSettingsWindow()) return;

    let fab = document.getElementById(FAB_ID);
    if (!fab) {
      fab = document.createElement("button");
      fab.id = FAB_ID;
      fab.type = "button";
      document.body.appendChild(fab);
    }
    // 图标：图片/壁纸意象（圆角画框 + 太阳 + 山峦），替换掉原来的「壁纸」文字
    fab.title = "壁纸引擎（可拖动）";
    fab.setAttribute("aria-label", "壁纸引擎");
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4.2"></rect>' +
      '<circle cx="8.8" cy="8.8" r="1.7"></circle>' +
      '<path d="M21 15.2l-3.1-3.1a2 2 0 0 0-2.8 0L6.2 21"></path>' +
      "</svg>";

    // 旧版把开合面板绑在 click 上；现在改成 pointerup 判断，必须显式摘掉旧监听，
    // 否则一次点击会「pointerup 切换 + click 切换」相互抵消。
    if (NS.hFabClick) {
      fab.removeEventListener("click", NS.hFabClick);
      NS.hFabClick = null;
    }

    // 单击开合面板，拖动则移动位置。
    // 用位移阈值区分两种意图——所以不再绑 click，改在 pointerup 里判断。
    let fabDragging = false;
    let fabMoved = false;
    let downX = 0;
    let downY = 0;
    let originX = 0;
    let originY = 0;

    rebind(fab, "pointerdown", "hFabDown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      fabDragging = true;
      fabMoved = false;
      downX = event.clientX;
      downY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      try {
        fab.setPointerCapture(event.pointerId);
      } catch {
        // 不支持指针捕获时退化为普通拖动
      }
      fab.classList.add("is-dragging");
      event.preventDefault();
    });

    rebind(fab, "pointermove", "hFabMove", (event) => {
      if (!fabDragging) return;
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (!fabMoved && Math.abs(dx) + Math.abs(dy) < 4) return; // 4px 以内算点击
      fabMoved = true;
      const rect = fab.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - rect.width - 8);
      const maxY = Math.max(8, window.innerHeight - rect.height - 8);
      NS.fabPos = {
        x: Math.round(Math.max(8, Math.min(maxX, originX + dx))),
        y: Math.round(Math.max(8, Math.min(maxY, originY + dy))),
      };
      applyFabPosition();
      if (NS.open) applyPanelPosition();
    });

    const endFabDrag = (event) => {
      if (!fabDragging) return;
      fabDragging = false;
      fab.classList.remove("is-dragging");
      try {
        fab.releasePointerCapture(event.pointerId);
      } catch {
        // 没捕获过就忽略
      }
      if (!fabMoved) {
        NS.open = !NS.open;
        renderPanel();
      }
    };
    rebind(fab, "pointerup", "hFabUp", endFabDrag);
    rebind(fab, "pointercancel", "hFabCancel", endFabDrag);

    // 双击 FAB 复位到右下角
    rebind(fab, "dblclick", "hFabDbl", () => {
      NS.fabPos = null;
      applyFabPosition();
      if (NS.open) applyPanelPosition();
    });

    if (!document.getElementById(PANEL_ID)) {
      const panel = document.createElement("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
  }

  /* ================= 壁纸引擎设置面板 =================
     由右侧「新标签页」里的「壁纸引擎设置」条目打开。
     面板本身完全由本脚本渲染，不受 React 重渲染影响。 */
  const SETTINGS_ID = "wb-we-settings";
  const NEWTAB_ENTRY_ID = "wb-we-newtab-entry";
  const SETTINGS_TABS = [
    { id: "wallpaper", label: "壁纸" },
    { id: "appearance", label: "外观" },
    { id: "playback", label: "播放" },
  ];

  function statRow(label, value, key) {
    return (
      '<div class="wbs-row"><span>' + esc(label) + "</span>" +
      "<b" + (key ? ' data-val="' + esc(key) + '"' : "") + ">" + value + "</b></div>"
    );
  }

  function sliderBlock(key, label, min, max, step, unit) {
    const value = NS.state[key];
    return (
      '<div class="wbs-block">' +
      statRow(label, value + unit, key) +
      '<input class="wbs-range" type="range" data-wbs-key="' + esc(key) + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">' +
      "</div>"
    );
  }

  function swatchBlock(label, current) {
    const schemes = NS.state.schemes || [];
    return (
      '<div class="wbs-block">' +
      statRow(label, "") +
      '<div class="wbs-swatches">' +
      schemes
        .map(
          (s) =>
            '<button class="wbs-swatch' + (s.id === current ? " is-active" : "") + '" data-wbs="scheme" data-value="' + esc(s.id) + '" title="' + esc(s.label) + '" style="--c:' + esc(s.accent) + '"></button>',
        )
        .join("") +
      "</div></div>"
    );
  }

  function segBlock(label, current, options, action) {
    return (
      '<div class="wbs-block">' +
      statRow(label, "") +
      '<div class="wbs-seg">' +
      options
        .map((o) => '<button class="' + (o.v === current ? "is-active" : "") + '" data-wbs="' + esc(action) + '" data-value="' + esc(o.v) + '">' + esc(o.t) + "</button>")
        .join("") +
      "</div></div>"
    );
  }

  function toggleRow(label, on, action) {
    return (
      '<button class="wbs-toggle' + (on ? " is-on" : "") + '" data-wbs="' + esc(action) + '">' +
      "<i></i><span>" + esc(label) + "</span></button>"
    );
  }

  // 壁纸卡片列表（搜索时只重绘这一块，避免输入框失焦）
  function wallpaperCardsHtml() {
    const items = NS.state.items || [];
    const q = String(NS.settingsSearch || "").trim().toLowerCase();
    const list = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    if (!list.length) return '<p class="wbs-empty">' + (items.length ? "没有匹配的壁纸" : "还没有壁纸，点「打开文件夹」放进去") + "</p>";
    const activeId = NS.state.active ? NS.state.active.id : null;
    return list
      .map((item) => {
        const thumb =
          item.kind === "video"
            ? '<video src="' + esc(item.url) + '" muted preload="metadata"></video>'
            : '<img src="' + esc(item.url) + '" loading="lazy" alt="">';
        return (
          '<button class="wbs-card' + (item.id === activeId ? " is-active" : "") + '" data-wbs="pick" data-value="' + esc(item.id) + '" title="' + esc(item.name) + '">' +
          thumb +
          '<span class="wbs-card-badge">' + (item.kind === "video" ? "视频" : item.kind === "gif" ? "GIF" : "图片") + "</span>" +
          (item.id === activeId ? '<span class="wbs-card-current">当前</span>' : "") +
          '<span class="wbs-card-name">' + esc(item.name) + "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function settingsTabBody(tab) {
    const st = NS.state;
    if (tab === "wallpaper") {
      return (
        '<div class="wbs-block"><input class="wbs-search" id="wbs-search" type="search" placeholder="搜索壁纸标题…" value="' + esc(NS.settingsSearch || "") + '"></div>' +
        '<div class="wbs-grid" id="wbs-grid">' + wallpaperCardsHtml() + "</div>"
      );
    }
    if (tab === "appearance") {
      return (
        swatchBlock("配色", st.palette.id) +
        sliderBlock("glass", "玻璃透明度", 0, 60, 1, "%") +
        '<div class="wbs-note">玻璃透明度同时作用于右侧面板、浮层与输入框。</div>' +
        '<div class="wbs-note">左侧栏与顶栏为全透明，不受此值影响。</div>'
      );
    }
    return (
      segBlock("适配方式", st.fit, [{ v: "cover", t: "覆盖" }, { v: "contain", t: "完整" }, { v: "fill", t: "拉伸" }], "fit") +
      sliderBlock("brightness", "亮度", 30, 160, 1, "%") +
      sliderBlock("saturation", "饱和度", 0, 200, 1, "%") +
      '<div class="wbs-block"><div class="wbs-sub">省电</div>' +
      toggleRow("窗口失焦时暂停", st.pauseOnBlur, "toggleBlur") +
      toggleRow("电池供电时暂停", st.pauseOnBattery, "toggleBattery") +
      "</div>"
    );
  }

  // 设置页只属于右侧面板里的「新标签页」那一页。宿主面板收起、或用户切走落地页之后，
  // 它就没地方可停靠了——此时必须关掉，否则它会变成一个 position:fixed 的浮层，
  // 一直挂在屏幕右边收不掉（用户反馈的「为啥一直浮在右边」）。
  function settingsHost() {
    const panel = document.querySelector("[data-view-id=detail-panel]");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    if (!(rect.width >= 120 && rect.height >= 120)) return null;
    // 落地页被我们自己的 visibility:hidden 藏着，但仍占布局；它存在就代表宿主页还在
    if (!panel.querySelector(".detail-new-tab-landing")) return null;
    return { panel: panel, rect: rect };
  }

  /* ---------- 设置页就地复用当前标签（不开新标签） ----------
     需求：点「壁纸引擎设置」入口 → **当前这个标签**就地改名成「壁纸引擎设置」
     （顺带换图标），内容区换成设置页；关掉时再改回「新标签页」。
     不开新标签，所以不往 React 的标签列表里塞节点 —— 只改现有节点的文字与图标，
     这对 React 最友好。 */
  const SETTINGS_TAB_TITLE = "壁纸引擎设置";

  function applySettingsTabTitle() {
    const tab = document.querySelector(".artifact-tab--active");
    const name = tab ? tab.querySelector(".artifact-tab__name") : null;
    if (!tab || !name) return;

    if (!NS.settingsOpen) {
      // 关闭：还原成原来的名字和图标
      const rec = NS.tabOriginal;
      NS.tabOriginal = null;
      if (!rec) return;
      if (rec.el && rec.el.isConnected) rec.el.textContent = rec.text;
      if (rec.iconEl && rec.iconEl.isConnected && rec.icon != null) rec.iconEl.innerHTML = rec.icon;
      return;
    }

    const tabId = tab.getAttribute("data-artifact-id") || "";
    if (NS.tabOriginal && NS.tabOriginal.tabId !== tabId) {
      // 激活的标签换人了（用户点了别的标签）→ 设置页让位，别去改人家的标题
      if (NS.closeSettings) NS.closeSettings();
      return;
    }
    if (!NS.tabOriginal) {
      const iconEl = tab.querySelector(".artifact-tab__icon");
      NS.tabOriginal = {
        el: name,
        text: name.textContent,
        iconEl: iconEl,
        icon: iconEl ? iconEl.innerHTML : null,
        tabId: tabId,
      };
    }
    // React 重渲染会把标题改回去，所以每次都写一遍（ensureSettingsWatcher 每 400ms 调这里）
    if (name.textContent !== SETTINGS_TAB_TITLE) name.textContent = SETTINGS_TAB_TITLE;
    const icon = tab.querySelector(".artifact-tab__icon");
    if (icon && icon.innerHTML !== NEWTAB_ICON) icon.innerHTML = NEWTAB_ICON;
  }

  // 设置页要「长在面板里」，就不能挂在 body 上做 fixed 浮层 ——
  // 得把它塞进面板自己的内容容器（.detail-main__body）当子节点，
  // 让它参与面板的布局与层叠。React 重渲染把它踢出来时，watcher 会再塞回去。
  const SETTINGS_MOUNT_SELECTORS = [".detail-main__body", ".detail-layout__content"];

  function settingsMountPoint() {
    const panel = document.querySelector("[data-view-id=detail-panel]");
    if (!panel) return null;
    for (const selector of SETTINGS_MOUNT_SELECTORS) {
      const el = panel.querySelector(selector);
      if (el) return el;
    }
    return panel;
  }

  function mountSettingsIntoPanel(box) {
    const target = settingsMountPoint();
    if (!target) return false;
    if (box.parentElement === target) return true;
    // 挂载点得能当绝对定位的基准
    if (getComputedStyle(target).position === "static") target.style.position = "relative";
    target.appendChild(box);
    return true;
  }

  // 只管「该不该显示」和「挂没挂在面板里」——位置交给 CSS（absolute + inset:0），
  // 不再自己算坐标，也就不会再出现算错/算慢导致的浮层感。
  function applySettingsPosition() {
    const box = document.getElementById(SETTINGS_ID);
    if (!box) return;
    const host = settingsHost();
    if (!host) {
      // 右侧面板收起了（或还没打开）：先藏起来但**保持打开状态**，
      // 面板再打开时自动回来 —— 否则用户一收起面板，标签标题就被还原成
      // 「新标签页」，设置也白开了。连续两次量不到才藏，避开重渲染的瞬时缺失。
      NS.settingsHostMisses = (NS.settingsHostMisses || 0) + 1;
      if (NS.settingsHostMisses >= 2) box.style.display = "none";
      return;
    }
    NS.settingsHostMisses = 0;
    box.style.display = "";
    // 清掉旧版本留下的内联坐标（那时是 fixed 浮层靠 JS 算坐标），
    // 否则会盖过 CSS 的 inset:0
    box.style.left = "";
    box.style.top = "";
    box.style.width = "";
    box.style.height = "";
    box.classList.add("is-docked");
    box.classList.remove("is-floating");
    mountSettingsIntoPanel(box);
  }

  function renderSettings() {
    const box = document.getElementById(SETTINGS_ID);
    if (!box) return;
    box.classList.toggle("is-open", NS.settingsOpen === true);
    // 隐藏落地页，避免两层内容叠加
    document.documentElement.classList.toggle("wb-we-settings-open", NS.settingsOpen === true);
    if (!NS.settingsOpen) {
      box.style.display = "";
      box.innerHTML = "";
      applySettingsTabTitle();
      return;
    }
    applySettingsTabTitle();
    applySettingsPosition();

    const st = NS.state;
    const active = st.active;
    const tab = NS.settingsTab || "wallpaper";
    const thumb = active
      ? active.kind === "video"
        ? '<video src="' + esc(active.url) + '" muted autoplay loop playsinline></video>'
        : '<img src="' + esc(active.url) + '" alt="">'
      : '<span class="wbs-thumb-empty"></span>';
    const kindText = active
      ? active.kind === "video"
        ? "视频 · 播放中"
        : active.kind === "gif"
          ? "GIF 动图"
          : "静态图片"
      : "未选择壁纸";

    // 不再渲染内容区自己的标题栏：标签栏上已经有「壁纸引擎设置」了，
    // 再来一行同名标题就是重复。关闭走标签上的 × 或 Esc。
    box.innerHTML =
      '<div class="wbs-now">' +
      '<span class="wbs-thumb">' + thumb + "</span>" +
      '<span class="wbs-now-text"><b>' + esc(active ? active.name : "—") + "</b><i>" + kindText + "</i></span>" +
      '<span class="wbs-now-actions">' +
      '<button data-wbs="clear">清除</button>' +
      '<button data-wbs="rescan">刷新</button>' +
      '<button data-wbs="openFolder">打开文件夹</button>' +
      "</span></div>" +
      '<div class="wbs-tabs">' +
      SETTINGS_TABS.map((t) => '<button class="' + (t.id === tab ? "is-active" : "") + '" data-wbs="tab" data-value="' + t.id + '">' + t.label + "</button>").join("") +
      "</div>" +
      '<div class="wbs-body">' + settingsTabBody(tab) + "</div>";

    for (const input of box.querySelectorAll(".wbs-range")) {
      const key = input.getAttribute("data-wbs-key");
      input.addEventListener("input", () => {
        const value = Number(input.value);
        NS.state[key] = value;
        const label = box.querySelector('[data-val="' + key + '"]');
        if (label) label.textContent = value + "%";
        if (key === "glass") applyCss();
        else applyMedia();
      });
      input.addEventListener("change", () => {
        const patch = {};
        patch[key] = Number(input.value);
        applyPatch(patch);
      });
    }

    const search = box.querySelector("#wbs-search");
    if (search) {
      search.addEventListener("input", () => {
        NS.settingsSearch = search.value;
        const grid = box.querySelector("#wbs-grid");
        if (grid) {
          grid.innerHTML = wallpaperCardsHtml();
          primeVideoThumbs(grid);
        }
      });
    }
    primeVideoThumbs(box);
  }

  function openSettings() {
    // 没有可停靠的右侧面板就别开——否则它只会变成一个挂在右边的浮层
    if (!settingsHost()) return;
    NS.settingsOpen = true;
    NS.settingsHostMisses = 0;
    NS.settingsTab = NS.settingsTab || "wallpaper";
    if (NS.open) {
      NS.open = false;
      renderPanel();
    }
    renderSettings();
  }

  function closeSettings() {
    NS.settingsOpen = false;
    NS.settingsHostMisses = 0;
    renderSettings();
  }

  function handleSettingsAction(event) {
    const node = event.target.closest ? event.target.closest("[data-wbs]") : null;
    if (!node) return;
    const action = node.getAttribute("data-wbs");
    const value = node.getAttribute("data-value");
    const st = NS.state;

    if (action === "close") closeSettings();
    else if (action === "tab") {
      NS.settingsTab = value;
      renderSettings();
    } else if (action === "pick") {
      commitLocal({ activeId: value });
      push({ type: "setActive", id: value });
      refresh();
    } else if (action === "clear") {
      commitLocal({ activeId: null });
      push({ type: "setActive", id: null });
      refresh();
    }     else if (action === "rescan") {
      push({ type: "rescan" });
      ackHostAction(node);
    } else if (action === "openFolder") {
      push({ type: "openFolder" });
      ackHostAction(node);
    }
    else if (action === "scheme") {
      commitLocal({ scheme: value });
      push({ type: "set", patch: { scheme: value } });
      refresh();
    } else if (action === "fit") {
      commitLocal({ fit: value });
      push({ type: "set", patch: { mode: value } });
      refresh();
    } else if (action === "toggleBlur") {
      const next = !st.pauseOnBlur;
      commitLocal({ pauseOnBlur: next });
      push({ type: "set", patch: { pauseOnBlur: next } });
      refresh();
    } else if (action === "toggleBattery") {
      const next = !st.pauseOnBattery;
      commitLocal({ pauseOnBattery: next });
      push({ type: "set", patch: { pauseOnBattery: next } });
      refresh();
    }
  }

  function applyPatch(patch) {
    commitLocal(patch);
    push({ type: "set", patch: patch });
    refresh();
  }

  function bindSettings() {
    // 兼容早期实现：那版会往标签栏注入一个 #wb-we-settings-tab 节点。
    // 现在改成「就地复用当前标签」，所以把它清掉（不清会多出一个重复标签）。
    const stale = document.getElementById("wb-we-settings-tab");
    if (stale) stale.remove();

    let box = document.getElementById(SETTINGS_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = SETTINGS_ID;
      document.body.appendChild(box);
    }
    rebind(box, "click", "hSettingsClick", handleSettingsAction);
    // Esc 关闭：留一条永远可用的退路，不依赖鼠标点得准不准。
    // 设置页优先，其次才是壁纸面板。
    rebind(document, "keydown", "hSettingsKey", (event) => {
      if (event.key !== "Escape") return;
      if (NS.settingsOpen) {
        closeSettings();
        event.stopPropagation();
      } else if (NS.open) {
        closePanel();
      }
    });
    // 点了别的标签 → 设置页让位（它是「占用当前标签」，不是盖在所有标签上的浮层）。
    // 用 data-artifact-id 认「我们占用的那个标签」：React 的根监听器先于 document 触发，
    // 用「谁是 active」判断会失效（那时 active 已经变成用户点的新标签了）。
    rebind(document, "click", "hTabsOther", (event) => {
      if (!NS.settingsOpen) return;
      const tab = event.target.closest ? event.target.closest(".artifact-tab") : null;
      if (!tab) return;
      const tabId = tab.getAttribute("data-artifact-id") || "";
      if (NS.tabOriginal && NS.tabOriginal.tabId === tabId) return;
      closeSettings();
    });
    // 点标签上的 × → **立刻**收起设置页，别等 400ms 轮询。
    // 两个要点：
    //   ① 必须用**捕获阶段**：React 的标签关闭处理会 stopPropagation，
    //      冒泡阶段挂在 document 上的监听器收不到；document 的捕获早于
    //      React 根容器（它是 document 的后代）上的任何监听器。
    //   ② 必须挂 **pointerdown** 而不是 click：React 在按下阶段就把标签移除了，
    //      等 click 触发时元素已经不在 DOM 里，closest 找不到，监听器等于白挂。
    rebind(
      document,
      "pointerdown",
      "hTabCloseDown",
      (event) => {
        if (!NS.settingsOpen) return;
        const btn = event.target.closest ? event.target.closest(".artifact-tab__close") : null;
        if (!btn) return;
        const tab = btn.closest(".artifact-tab");
        const tabId = tab ? tab.getAttribute("data-artifact-id") || "" : "";
        // 只认「我们占用的那个标签」：点别的标签的 × 不该关掉设置页
        if (!NS.tabOriginal || NS.tabOriginal.tabId !== tabId) return;
        closeSettings();
      },
      true,
    );
    // 窗口尺寸变化时重新贴合面板
    rebind(window, "resize", "hSettingsResize", () => {
      if (NS.settingsOpen) applySettingsPosition();
    });
    ensureSettingsWatcher();
  }

  // 右侧面板的开合是「纯 CSS 宽度变化」——既不触发 window resize，
  // 也不是 childList 变化，光靠 resize / MutationObserver 抓不到，
  // 结果就是面板收起后设置页还赖在右边。用一个轻量轮询盯住它。
  // 必须走 NS 间接层取函数，否则会锁死在第一次注入的旧闭包上。
  function ensureSettingsWatcher() {
    if (NS.settingsWatchTimer) return;
    NS.settingsWatchTimer = setInterval(() => {
      if (!NS.settingsOpen) return;
      // React 重渲染会把标签标题改回去，顺手再压一次
      if (NS.applySettingsTabTitle) NS.applySettingsTabTitle();
      if (NS.applySettingsPosition) NS.applySettingsPosition();
    }, 400);
  }

  /* ---------- 往右侧「新标签页」注入入口 ---------- */
  const NEWTAB_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2"></rect>' +
    '<circle cx="5.7" cy="6.6" r="1.05"></circle>' +
    '<path d="M13.6 10.4l-3.1-3.1L4.5 13.4"></path></svg>';

  function mountNewTabEntry() {
    const landing = document.querySelector(".detail-new-tab-landing");
    if (!landing) return;

    const list = landing.querySelector(".detail-new-tab-landing__list");
    const sample = list && list.querySelector(".detail-new-tab-landing__entry");
    if (!list || !sample) return;

    let entry = document.getElementById(NEWTAB_ENTRY_ID);
    if (!entry) {
      // 直接克隆现有条目的标签与属性，样式天然一致
      entry = sample.cloneNode(false);
      entry.removeAttribute("data-entry-key");
      entry.id = NEWTAB_ENTRY_ID;
      entry.title = "壁纸引擎设置";
      entry.innerHTML =
        '<span class="detail-new-tab-landing__entry-icon" aria-hidden="true">' + NEWTAB_ICON + "</span>" +
        '<span class="detail-new-tab-landing__entry-label">壁纸引擎设置</span>';
      list.appendChild(entry);
    }

    // 每次注入都是新的闭包，而旧监听器摘不掉（没留存引用）。
    // 用克隆替换整个节点来清空监听器，再挂上最新版本的处理器。
    const fresh = entry.cloneNode(true);
    entry.replaceWith(fresh);
    fresh.addEventListener("click", (event) => {
      // 别让这次点击冒到 React 根监听器：它会连带重渲染标签栏，
      // 把我们在标签上压掉的激活态又加回来（表现为两个「当前标签」）。
      event.stopPropagation();
      openSettings();
    });
  }

  function observeNewTab() {
    if (NS.newTabObserver || !window.MutationObserver) return;
    let pending = false;
    NS.newTabObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        // 必须通过 NS 取「最新一次注入」的函数。
        // 观察器只建一次，回调闭包会锁死在创建时的旧函数上，
        // 直接用 mountNewTabEntry / applySettingsPosition 会一直跑旧代码。
        if (NS.mountNewTabEntry) NS.mountNewTabEntry();
        if (NS.settingsOpen && NS.applySettingsPosition) NS.applySettingsPosition();
      }, 350);
    });
    NS.newTabObserver.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    if (!document.body) return;

    // 设置窗口保持**完全原生**：不注入壁纸层，也不注入任何样式。
    // 这里只做一件事 —— 把可能已经注入进去的东西摘干净（新开窗口时
    // body 的 settings-window 类是晚加的，第一次进来这里可能还没认出来）。
    if (isSettingsWindow()) {
      restoreSettingsWindow();
      return;
    }

    NS.syncPlayback = syncPlayback;
    // 暴露给 MutationObserver / 定时器 / 注入标签的回调用：
    // 这些生命周期长于单次注入，闭包会锁死旧函数
    NS.applySettingsPosition = applySettingsPosition;
    NS.renderSettings = renderSettings;
    NS.mountNewTabEntry = mountNewTabEntry;
    NS.applySettingsTabTitle = applySettingsTabTitle;
    NS.openSettings = openSettings;
    NS.closeSettings = closeSettings;

    if (NS.version !== SCRIPT_VERSION) {
      for (const id of [FAB_ID, PANEL_ID]) {
        const stale = document.getElementById(id);
        if (stale) stale.remove();
      }
      NS.version = SCRIPT_VERSION;
    }

    resolveState();
    applyCss();
    applyMedia();
    bindPlaybackListeners();
    ensureChrome();
    renderPanel();
    bindPanelElement();
    bindDismiss();
    bindSettings();
    mountNewTabEntry();
    observeNewTab();
    watchSettingsWindow();
    applyFabPosition();
    applyPanelPosition();
    syncPlayback();
  }

  run();
})();
