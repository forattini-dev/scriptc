// @rust-only
// @no-engine
import { fileURLToPath } from "node:url";
export function ownUrl(): string { return import.meta.url; }
const read = () => import.meta.filename;
console.log("metadata", import.meta.url, import.meta.filename, import.meta.dirname);
console.log("repeat", ownUrl() === import.meta.url, read() === fileURLToPath(ownUrl()));
