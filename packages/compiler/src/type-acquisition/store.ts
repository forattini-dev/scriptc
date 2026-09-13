import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { maxSatisfying, satisfies, valid, validRange } from "semver";
import { boundedFetch, declarationFiles, verifyIntegrity } from "./archive.js";

export interface DeclarationPackage {
  name: string;
  version: string;
  integrity: string;
  tarball: string;
  dependencies: Record<string, string>;
}
export interface TypesLock {
  version: 1;
  requests: Record<string, { package: string; subpath: string }>;
  packages: Record<string, DeclarationPackage>;
}
export const emptyTypesLock = (): TypesLock => ({ version: 1, requests: Object.create(null) as TypesLock["requests"], packages: Object.create(null) as TypesLock["packages"] });
export const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected declaration metadata object");
  return value as Record<string, unknown>;
}
export function packageName(name: string): boolean { return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name); }
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected declaration metadata string");
  return value;
}

export async function readTypesLock(path: string): Promise<TypesLock> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyTypesLock(); throw error; }
  const raw = object(JSON.parse(text));
  if (raw["version"] !== 1) throw new Error("unsupported scriptc types lock version");
  const lock = emptyTypesLock();
  for (const [key, value] of Object.entries(object(raw["packages"]))) {
    const pkg = object(value);
    const name = string(pkg["name"]), version = string(pkg["version"]);
    if (!packageName(name) || !valid(version) || key !== `${name}@${version}`) throw new Error("invalid declaration lock identity");
    const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [dep, pinned] of Object.entries(object(pkg["dependencies"]))) {
      if (!packageName(dep)) throw new Error("invalid declaration dependency name");
      dependencies[dep] = string(pinned);
    }
    lock.packages[key] = { name, version, integrity: string(pkg["integrity"]), tarball: string(pkg["tarball"]), dependencies };
  }
  for (const [key, value] of Object.entries(object(raw["requests"]))) {
    const request = object(value);
    const pinned = string(request["package"]);
    if (!Object.hasOwn(lock.packages, pinned)) throw new Error("declaration request references missing package");
    lock.requests[key] = { package: pinned, subpath: string(request["subpath"]) };
  }
  for (const pkg of Object.values(lock.packages)) for (const dep of Object.values(pkg.dependencies)) {
    if (!Object.hasOwn(lock.packages, dep)) throw new Error("declaration lock has an incomplete dependency graph");
  }
  return lock;
}

export async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export class DeclarationStore {
  readonly loaded = new Map<string, Map<string, string>>();
  constructor(readonly cache: string, readonly lock: TypesLock, readonly offline: boolean,
    private readonly download: (url: string) => Promise<Buffer> = boundedFetch) {}

  async files(key: string): Promise<Map<string, string>> {
    const memo = this.loaded.get(key);
    if (memo) return memo;
    const pkg = this.lock.packages[key];
    if (!pkg) throw new Error(`missing locked declaration package ${key}`);
    const cachePath = join(this.cache, `${digest(pkg.integrity)}.tgz`);
    let bytes: Buffer;
    try { bytes = await readFile(cachePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.offline) throw new Error(`offline declaration cache miss: ${key}`);
      bytes = await this.download(pkg.tarball);
      verifyIntegrity(bytes, pkg.integrity);
      declarationFiles(bytes);
      await atomicWrite(cachePath, bytes);
    }
    verifyIntegrity(bytes, pkg.integrity);
    const files = declarationFiles(bytes);
    const manifest = object(JSON.parse(files.get("package.json") ?? ""));
    if (manifest["name"] !== pkg.name || manifest["version"] !== pkg.version) throw new Error(`declaration package identity mismatch: ${key}`);
    this.loaded.set(key, files);
    return files;
  }

  validateGraph(): void {
    for (const [key, files] of this.loaded) {
      const manifest = object(JSON.parse(files.get("package.json") ?? ""));
      const dependencies = object(manifest["dependencies"] ?? {});
      const pinned = this.lock.packages[key]?.dependencies ?? {};
      if (Object.keys(dependencies).length !== Object.keys(pinned).length) throw new Error(`declaration dependency lock mismatch: ${key}`);
      for (const [name, range] of Object.entries(dependencies)) {
        const dep = this.lock.packages[pinned[name] ?? ""];
        if (!dep || dep.name !== name || !satisfies(dep.version, string(range))) throw new Error(`incompatible locked declaration dependency ${key} -> ${name}`);
      }
    }
  }

  async acquire(name: string, range: string, depth = 0): Promise<string> {
    if (depth > 32 || this.loaded.size > 256) throw new Error("declaration dependency graph exceeds size limit");
    if (!packageName(name) || !validRange(range)) throw new Error(`unsupported declaration dependency ${name}@${range}`);
    if (this.offline) throw new Error(`offline declaration lock miss: ${name}@${range}`);
    const registry = object(JSON.parse((await this.download(`https://registry.npmjs.org/${encodeURIComponent(name)}`)).toString("utf8")));
    const versions = object(registry["versions"]);
    const version = maxSatisfying(Object.keys(versions), range);
    if (!version) throw new Error(`no compatible declarations for ${name}@${range}; an explicit compatible contract is required`);
    const key = `${name}@${version}`;
    if (Object.hasOwn(this.lock.packages, key)) return key;
    const meta = object(versions[version]);
    const dist = object(meta["dist"]);
    const pkg: DeclarationPackage = { name, version, integrity: string(dist["integrity"]), tarball: string(dist["tarball"]), dependencies: Object.create(null) as Record<string, string> };
    this.lock.packages[key] = pkg;
    const files = await this.files(key);
    const manifest = object(JSON.parse(files.get("package.json") ?? ""));
    for (const [dep, constraint] of Object.entries(object(manifest["dependencies"] ?? {}))) {
      // Pin a declaration-only graph. No npm install and no lifecycle scripts.
      pkg.dependencies[dep] = await this.acquire(dep, string(constraint), depth + 1);
    }
    return key;
  }
}
