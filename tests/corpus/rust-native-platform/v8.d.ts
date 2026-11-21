declare module "node:v8" {
  export function getHeapStatistics(): { heap_size_limit: number };
}
