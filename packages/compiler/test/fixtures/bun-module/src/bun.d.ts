// The minimal bun-types ambient surface the fixture needs: the "bun"
// module re-exports node:url members (bun-types declares the same).
declare module "bun" {
  export { pathToFileURL, fileURLToPath } from "node:url";
  // A Bun runtime API with no compiled counterpart (trap.ts): a module-loader hook.
  export function plugin(options: { name: string }): void;
}
