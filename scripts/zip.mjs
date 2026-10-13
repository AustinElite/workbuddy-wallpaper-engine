// 极简 ZIP 打包器：只用 Node 标准库，不依赖 tar / PowerShell / 任何外部程序。
//
// 为什么自己写：release 流程只需要「把一个目录压成 zip」这一件事，
// 而调用外部程序会受沙箱、PATH、杀软、系统版本影响 —— 出问题时很难解释，
// 而且没法自动化验证。用 zlib 自己写反而更短、更可控。
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ZIP 用的 CRC32（表驱动）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ZIP 用的是 DOS 时间格式（1980 起算）
function dosStamp(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function collect(dir, base = dir, out = [], exclude) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");
    if (exclude && exclude.test(rel)) continue;
    if (entry.isDirectory()) collect(full, base, out, exclude);
    else out.push({ full, name: rel });
  }
  return out;
}

/**
 * 把 sourceDir 压成 outFile。
 * @param {string} sourceDir 要打包的目录
 * @param {string} outFile   输出 zip 路径
 * @param {string} [rootName] 包内顶层目录名（默认用 sourceDir 的目录名）
 * @param {{exclude?: RegExp}} [options] exclude 命中相对路径的文件/目录会被跳过
 */
export function zipDirectory(sourceDir, outFile, rootName = "", { exclude } = {}) {
  const root = rootName || sourceDir.split(/[\\/]/).filter(Boolean).pop();
  const files = collect(sourceDir, sourceDir, [], exclude);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const raw = readFileSync(file.full);
    const deflated = deflateRawSync(raw, { level: 9 });
    // 压不动的小文件直接存原样（method 0），比强压更合理
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(`${root}/${file.name}`, "utf8");
    const { time, day } = dosStamp(statSync(file.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 生成程序版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // 对应本地头的偏移
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  writeFileSync(outFile, Buffer.concat([...localParts, centralBuf, eocd]));
  return { files: files.length, bytes: statSync(outFile).size };
}
