import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MEDIA_KIND, MIN_MEDIA_BYTES } from "./constants.mjs";

const SKIP_DIRS = new Set(["node_modules", "$RECYCLE.BIN", "System Volume Information"]);

export function idForPath(filePath) {
  return createHash("sha1").update(String(filePath).toLowerCase()).digest("hex").slice(0, 12);
}

export function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// 广度优先遍历，限制深度与总量，避免大目录卡死
export async function scanFolders(folders, { maxDepth = 4, maxFiles = 2000 } = {}) {
  const items = [];
  const seen = new Set();
  const queue = folders.filter(Boolean).map((dir) => ({ dir, depth: 0 }));

  while (queue.length > 0 && items.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (items.length >= maxFiles) break;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      const kind = MEDIA_KIND[ext];
      if (!kind) continue;

      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size < MIN_MEDIA_BYTES) continue;

      items.push({
        id: idForPath(full),
        name: basename(entry.name, ext),
        file: full,
        url: pathToFileURL(full).href,
        kind,
        ext,
        size: info.size,
        sizeText: formatSize(info.size),
        mtime: Math.round(info.mtimeMs),
        folder: dir,
      });
    }
  }

  return items.sort((a, b) => b.mtime - a.mtime);
}

export function visibleItems(items, config) {
  const hidden = new Set(config.hidden);
  return items.filter((item) => !hidden.has(item.id));
}
