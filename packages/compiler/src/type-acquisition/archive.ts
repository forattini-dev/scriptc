import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const MAX_DOWNLOAD = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;

/** Authenticate compressed bytes before parsing or caching them. */
export function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match?.[1] || !match[2]) throw new Error("declaration tarball requires SHA-512 or SHA-256 integrity");
  const actual = createHash(match[1]).update(bytes).digest();
  const expected = Buffer.from(match[2], "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("declaration tarball integrity mismatch");
  }
}

/** No filesystem extraction, links, scripts or executable sources. Npm's
 * package prefix is stripped only after validating every archive path. */
export function declarationFiles(bytes: Buffer): Map<string, string> {
  if (bytes.length > MAX_DOWNLOAD) throw new Error("declaration download exceeds size limit");
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
  const files = new Map<string, string>();
  let entries = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    if (++entries > 5000) throw new Error("too many declaration archive entries");
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const octal = (value: string): number => {
      if (!/^[0-7]+$/.test(value.trim())) throw new Error("invalid tar numeric field");
      return Number.parseInt(value.trim(), 8);
    };
    const checksum = octal(field(148, 8));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i] ?? 0;
    if (sum !== checksum) throw new Error("invalid declaration tar header checksum");
    const size = octal(field(124, 12));
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : "") + field(0, 100);
    const parts = name.replace(/\/$/, "").split("/");
    if (name.includes("\\") || parts.some(part => part === "" || part === "." || part === ".." || part.includes(":"))) {
      throw new Error("unsafe declaration archive path");
    }
    const type = field(156, 1);
    if (type !== "" && type !== "0" && type !== "5") throw new Error("unsupported declaration archive entry (links and extended headers are refused)");
    const end = offset + 512 + size;
    if (end > tar.length) throw new Error("truncated declaration archive");
    const relative = parts.slice(1).join("/");
    if (type !== "5" && relative && (/\.d\.(?:ts|mts|cts)$/.test(relative) || relative.endsWith(".json"))) {
      if (files.has(relative)) throw new Error("duplicate declaration archive path");
      files.set(relative, tar.subarray(offset + 512, end).toString("utf8"));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has("package.json")) throw new Error("declaration archive has no package.json");
  return files;
}

export async function boundedFetch(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org" || parsed.username || parsed.password) {
    throw new Error("declaration downloads must use https://registry.npmjs.org");
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`declaration registry returned HTTP ${response.status}`);
  if (!response.body) throw new Error("empty declaration registry response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > MAX_DOWNLOAD) throw new Error("declaration download exceeds size limit");
      chunks.push(Buffer.from(result.value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
