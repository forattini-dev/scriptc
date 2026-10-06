/* A library project module: reaching it makes the compiler read
 * lib/tsconfig.json, whose `types: ["node"]` resolves lib's own
 * node_modules/@types/node (the real new-layout 26.1.2). */
export function label(name: string): string {
  return `lib:${name}`;
}
