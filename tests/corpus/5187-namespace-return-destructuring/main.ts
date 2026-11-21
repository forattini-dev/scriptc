import * as imported from "./module.ts";

function requireModule(): typeof import("./module.ts") {
  return imported;
}

function main(): void {
  const { greet, LABEL } = requireModule();
  console.log(greet("native"));
  console.log(LABEL);
}

main();
