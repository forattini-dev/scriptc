import { value } from "./dynamic-lazy-lib.ts";
async function run(): Promise<void> {
  const imported = (await import("./dynamic-lazy-lib.ts")).value;
  console.log(imported === value);
  console.log(imported());
}
void run();
console.log("entry");
