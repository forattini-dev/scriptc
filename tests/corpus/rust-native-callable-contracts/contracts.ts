// @rust-only
// @no-engine
import { endpoint } from "./api.js";
const alias = endpoint;
console.log("JS callable", endpoint(4), endpoint.parse(3), endpoint.offset, alias === endpoint);
alias.offset = 10;
console.log("JS alias", endpoint.offset, endpoint(5));
function absent(callback?: (value: string) => boolean): number { return 7; }
console.log("absent signature", absent());
function effect(label: string, value = 2): void { console.log("bound void", label, value); }
const bound = effect.bind(null, "native");
bound();
bound(0);
function last(a0: number, a1: number, a2: number, a3: number, a4: number, a5: number, a6: number, a7: number, a8: number, a9: number, a10: number): number { return a10; }
const many = last.bind(null);
console.log("tuple ABI order", many(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
