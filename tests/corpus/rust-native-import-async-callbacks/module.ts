export interface Seams { read?: (key: string) => Promise<string>; }
export function use(seams: Seams = {}): Promise<string> {
  return seams.read ? seams.read("input") : Promise.resolve("default");
}
export function echo(value: Promise<string>): Promise<string> { return value; }
export const services: { name: string; run: () => Promise<boolean>; optional?: () => Promise<string> }[] = [
  { name: "service", run: () => Promise.resolve(true), optional: () => Promise.resolve("optional") },
];
export function signature(pattern: RegExp): RegExp { return pattern; }
