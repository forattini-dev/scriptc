// The minimal bun-types ambient surface the fixture needs: the "bun"
// module re-exports node:url members (bun-types declares the same).
declare module "bun" {
  export { pathToFileURL, fileURLToPath } from "node:url";
}
