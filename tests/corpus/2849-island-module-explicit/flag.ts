export const FLAGS = ["alpha", "beta", "gamma"];

let counter = 0;

export function isEnabled(name: string): boolean {
  return FLAGS.includes(name);
}

export function bump(): number {
  counter += 1;
  return counter;
}

export function describe(name: string): { name: string; enabled: boolean; rank: number } {
  return { name, enabled: isEnabled(name), rank: FLAGS.indexOf(name) };
}
