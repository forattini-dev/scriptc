import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";

/** Acquired declarations have their own per-operation context. They never
 * enter externalTypes, whose modules are supplied by an external host. */
export class DeclarationOverlay {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly resolutions = new Map<string, { typesFile: string; packageName: string; version: string }>();
  readonly mounts = new Map<string, string>();

  add(path: string, text: string): void {
    path = resolve(path);
    this.files.set(path, text);
    for (let dir = dirname(path); !this.directories.has(dir); dir = dirname(dir)) {
      this.directories.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  entries(path: string): { files: string[]; directories: string[] } {
    const files = [...this.files.keys()].filter(file => dirname(file) === path).map(file => file.slice(path.length + 1));
    const directories = [...this.directories].filter(dir => dirname(dir) === path && dir !== path).map(dir => dir.slice(path.length + 1));
    return { files, directories };
  }
}

const context = new AsyncLocalStorage<DeclarationOverlay>();
export const acquiredDeclarations = (): DeclarationOverlay | undefined => context.getStore();
export function withDeclarationOverlay<T>(overlay: DeclarationOverlay, run: () => T): T { return context.run(overlay, run); }
export function acquiredResolution(from: string, specifier: string) {
  return context.getStore()?.resolutions.get(`${resolve(from)}\0${specifier}`);
}
