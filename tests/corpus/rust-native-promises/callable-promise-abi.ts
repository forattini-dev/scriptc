import { make } from "./callable-promise-abi-lib.js";
const broad: (value: any) => Promise<any> = make;
const narrow: (value: string) => Promise<{ value: string }> = make;
console.log(broad === narrow);
void narrow("native").then((result) => console.log(result.value));
