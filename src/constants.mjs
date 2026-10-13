import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "workbuddy-wallpaper-engine";
export const PRODUCT_NAME = "WorkBuddy Wallpaper Engine";
export const CONFIG_VERSION = 1;
export const DEFAULT_CDP_PORT = 9223;

// 扩展名 -> 媒体类型
export const MEDIA_KIND = {
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".m4v": "video",
  ".ogv": "video",
  ".mkv": "video",
  ".gif": "gif",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".avif": "image",
  ".bmp": "image",
};

export const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"]);

export const MIN_MEDIA_BYTES = 1024;

export function resolvePaths({ home = homedir() } = {}) {
  const installRoot = join(home, `.${PRODUCT_ID}`);
  return {
    installRoot,
    configPath: join(installRoot, "config.json"),
    logPath: join(installRoot, "engine.log"),
    pidPath: join(installRoot, "engine.pid"),
    defaultWallpaperDir: join(installRoot, "wallpapers"),
  };
}

// surface 亮度 > 0.6 视为浅色主题（与 WorkBuddy 的 data-vscode-theme-kind 对齐）
export function luminance(hex) {
  const value = parseInt(String(hex).replace("#", "").slice(0, 6), 16);
  if (!Number.isFinite(value)) return 0;
  return (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
}
