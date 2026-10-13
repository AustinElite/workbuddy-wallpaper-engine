import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CONFIG_VERSION, DEFAULT_CDP_PORT, resolvePaths } from "./constants.mjs";

export const SCHEMES = [
  { id: "aurora", label: "极光", accent: "#5EC8E5", surface: "#0E1620", text: "#E6F1F7" },
  { id: "sakura", label: "樱", accent: "#E58FB8", surface: "#1B1219", text: "#F7E6EF" },
  { id: "amber", label: "琥珀", accent: "#E0A94F", surface: "#17140E", text: "#F2E8D5" },
  { id: "forest", label: "森", accent: "#5FC08A", surface: "#0F1712", text: "#E2F2E8" },
  { id: "violet", label: "暮紫", accent: "#A78BFA", surface: "#141024", text: "#EDE9FE" },
  { id: "mono", label: "素白", accent: "#7C8794", surface: "#F4F5F7", text: "#1C2026" },
];

export const FIT_MODES = ["cover", "contain", "fill"];

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    folders: [],
    activeId: null,
    mode: "cover",
    brightness: 100,
    saturation: 100,
    glass: 24,
    scheme: "aurora",
    customAccent: null,
    pauseOnBlur: true,
    pauseOnBattery: true,
    hidden: [],
    port: DEFAULT_CDP_PORT,
    updatedAt: 0,
  };
}

export function normalizeConfig(input) {
  const base = defaultConfig();
  if (!input || typeof input !== "object" || Array.isArray(input)) return base;
  const hex = (value) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null);

  return {
    version: CONFIG_VERSION,
    folders: Array.isArray(input.folders)
      ? [...new Set(input.folders.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()))]
      : [],
    activeId: typeof input.activeId === "string" && input.activeId ? input.activeId : null,
    mode: FIT_MODES.includes(input.mode) ? input.mode : base.mode,
    brightness: clamp(input.brightness, 20, 180, base.brightness),
    saturation: clamp(input.saturation, 0, 220, base.saturation),
    glass: clamp(input.glass, 0, 60, base.glass),
    scheme: SCHEMES.some((s) => s.id === input.scheme) ? input.scheme : base.scheme,
    customAccent: hex(input.customAccent),
    pauseOnBlur: input.pauseOnBlur !== false,
    pauseOnBattery: input.pauseOnBattery !== false,
    hidden: Array.isArray(input.hidden) ? [...new Set(input.hidden.filter((h) => typeof h === "string"))] : [],
    port: Number.isInteger(input.port) && input.port >= 1024 && input.port <= 65535 ? input.port : base.port,
    // 每次宿主落盘都会刷新，页面用它判断「本地改动」与「宿主配置」谁更新
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : 0,
  };
}

export async function loadConfig({ configPath = resolvePaths().configPath } = {}) {
  try {
    const raw = await readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return defaultConfig();
    throw error;
  }
}

export async function saveConfig(config, { configPath = resolvePaths().configPath } = {}) {
  const normalized = normalizeConfig(config);
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temporary, configPath);
  return normalized;
}

export function resolvePalette(config) {
  const scheme = SCHEMES.find((s) => s.id === config.scheme) ?? SCHEMES[0];
  return {
    id: scheme.id,
    label: scheme.label,
    accent: config.customAccent ?? scheme.accent,
    surface: scheme.surface,
    text: scheme.text,
  };
}
