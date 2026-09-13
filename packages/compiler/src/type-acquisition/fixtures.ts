import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, vi } from "vitest";

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-acquire-"));
  directories.push(root);
  const files = {
    "package.json": JSON.stringify({ name: "acquire-test", type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["main.ts"] }),
    "main.ts": 'import { answer } from "type-example"; const n: number = answer(); console.log(n);\n',
    "node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "1.2.0", main: "index.js", type: "module" }),
    "node_modules/type-example/index.js": "export function answer() { return 42; }\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}
export function archive(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write("0000644\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("        ", 148);
    header.write("0", 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
export function registry(files: Record<string, string> = {}, manifest: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const bytes = archive({
    "package.json": JSON.stringify({ name: "@types/type-example", version: "1.2.3", types: "index.d.ts", ...manifest }),
    "index.d.ts": "export function answer(): number;\n",
    "postinstall.js": "throw new Error('must never run');\n",
    ...files,
  });
  const dist = { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, tarball: "https://registry.npmjs.org/@types/type-example/-/type-example-1.2.3.tgz" };
  const mock = vi.fn(async (url: string) => new Response(url.endsWith(".tgz") ? new Uint8Array(bytes) : JSON.stringify({ versions: { "1.2.3": { dist } } }), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}


export function registryPackages(packages: { name: string; version: string; files?: Record<string, string>; manifest?: Record<string, unknown> }[]): ReturnType<typeof vi.fn> {
  const responses = new Map<string, string | Uint8Array>();
  const metadata = new Map<string, Record<string, unknown>>();
  for (const pkg of packages) {
    const bytes = archive({
      "package.json": JSON.stringify({ name: pkg.name, version: pkg.version, types: "index.d.ts", ...pkg.manifest }),
      "index.d.ts": "export function answer(): number;\n", ...pkg.files,
    });
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/-/${pkg.version}.tgz`;
    responses.set(url, new Uint8Array(bytes));
    const versions = metadata.get(pkg.name) ?? {};
    versions[pkg.version] = { dist: { tarball: url, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
    metadata.set(pkg.name, versions);
  }
  for (const [name, versions] of metadata) responses.set(`https://registry.npmjs.org/${encodeURIComponent(name)}`, JSON.stringify({ versions }));
  const mock = vi.fn(async (url: string) => {
    const body = responses.get(url);
    return new Response(body ?? "not found", { status: body === undefined ? 404 : 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
