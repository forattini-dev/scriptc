export const kind = "event";
export const ids = [1, 2, 3];
export type Shape = { id: number };

export function define(name: string): string {
  return "def:" + name;
}
