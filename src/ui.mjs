import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIT_MODES } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_TILES = 120;

let cache = null;

async function templates() {
  if (!cache) {
    const [panelCss, skinCssTemplate, scriptTemplate] = await Promise.all([
      readFile(join(HERE, "panel-style.css"), "utf8"),
      readFile(join(HERE, "skin-style.css"), "utf8"),
      readFile(join(HERE, "page-script.js"), "utf8"),
    ]);
    cache = { panelCss, skinCssTemplate, scriptTemplate };
  }
  return cache;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    kind: item.kind,
    sizeText: item.sizeText,
  };
}

export async function buildState({ config, palette, items, schemes }) {
  const { panelCss, skinCssTemplate } = await templates();
  const active = items.find((item) => item.id === config.activeId) ?? null;
  return {
    panelCss,
    skinCssTemplate,
    palette: {
      id: palette.id,
      accent: palette.accent,
      surface: palette.surface,
      text: palette.text,
    },
    schemes: schemes.map(({ id, label, accent, surface, text }) => ({ id, label, accent, surface, text })),
    hostUpdatedAt: config.updatedAt || 0,
    fitModes: FIT_MODES,
    fit: config.mode,
    glass: config.glass,
    brightness: config.brightness,
    saturation: config.saturation,
    pauseOnBlur: config.pauseOnBlur,
    pauseOnBattery: config.pauseOnBattery,
    items: items.slice(0, MAX_TILES).map(publicItem),
    active: active ? publicItem(active) : null,
  };
}

export async function buildInjection({ config, palette, items, schemes }) {
  const { scriptTemplate } = await templates();
  const state = await buildState({ config, palette, items, schemes });
  // 用函数式替换，避免 JSON 里的 $ 被当成替换模式
  return scriptTemplate.replace("__WBWE_STATE__", () => JSON.stringify(state));
}

export function buildQueueDrain() {
  // 顺便打一个心跳：页面靠 NS.lastBeat 判断「宿主守护进程还在不在」。
  // 守护进程没跑时，点「打开文件夹」这类动作会石沉大海，页面至少要能说清楚。
  return `(() => {
    const ns = window.__wbWe;
    if (!ns) return [];
    ns.lastBeat = Date.now();
    if (!Array.isArray(ns.queue) || ns.queue.length === 0) return [];
    const drained = ns.queue.slice();
    ns.queue.length = 0;
    return drained;
  })()`;
}

export function buildProbe() {
  return `(() => {
    const ns = window.__wbWe;
    return {
      panelStyle: Boolean(document.getElementById("wb-we-panel-style")),
      skinStyle: Boolean(document.getElementById("wb-we-skin-style")),
      media: Boolean(document.getElementById("wb-we-media")),
      panel: Boolean(document.getElementById("wb-we-panel")),
      activeId: ns && ns.mediaId ? ns.mediaId : null,
    };
  })()`;
}

export function buildTeardown() {
  return `(() => {
    const ids = [
      "wb-we-panel-style",
      "wb-we-skin-style",
      "wb-we-media",
      "wb-we-fab",
      "wb-we-panel",
    ];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
    if (window.__wbWe) {
      window.__wbWe.mediaId = null;
      window.__wbWe.mediaEl = null;
      window.__wbWe.queue = [];
    }
    return true;
  })()`;
}
