// The project dialect's own ambient surface — Bun types text assets
// exactly this way (bun-types ships `declare module "*.txt"`).
declare module "*.txt" {
  const content: string;
  export default content;
}
declare module "*.md" {
  const content: string;
  export default content;
}
