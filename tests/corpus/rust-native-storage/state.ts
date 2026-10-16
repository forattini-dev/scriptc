export interface Operation { name: string; enabled: boolean; tags?: string[] }

export let operations: Operation[] = [{ name: "first", enabled: true, tags: ["native"] }];
export let revision = 0;
export const groups: Record<string, Operation[] | undefined> = { primary: operations };
export const registry: ReadonlyMap<string, Operation[]> = new Map<string, Operation[]>([["primary", operations]]);

export function current(): Operation[] { return operations; }
export function replace(): void {
  operations = [{ name: "second", enabled: false }];
  revision = revision + 1;
}
export function recursive(n: number): number {
  if (n === 0) return revision;
  return recursive(n - 1);
}
export function getRevision(): number { return revision; }
export const callback = () => getRevision();
export function localAlias(value: Operation): () => string {
  const alias = value;
  return () => alias.name;
}
