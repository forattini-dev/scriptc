import { pathToFileURL } from "node:url";

export function helperIsMain(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]!).href;
}
