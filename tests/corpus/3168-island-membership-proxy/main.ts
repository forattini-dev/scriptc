// @dynamic
// @island-module: ./proxy-impl.ts
import { value as external } from "./proxy-impl.ts";
const value: unknown = external;
function check(key: string): boolean {
  return typeof value === 'object' && value !== null && key in value;
}
console.log(check('present'), check('missing'));
try { console.log(check('boom')); } catch (error) { console.log('caught', (error as Error).message); }
if (typeof value === 'object' && value !== null) {
  try { console.log('boom' in value); } catch (error) { console.log('literal', (error as Error).message); }
}
