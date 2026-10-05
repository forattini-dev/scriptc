/* A library project module: reaching it makes the compiler read
 * lib/tsconfig.json, whose `types: ["node"]` resolves lib's own
 * node_modules/@types/node (the new-layout copy). */
export function label(name: string): string {
  return `lib:${name}`;
}
