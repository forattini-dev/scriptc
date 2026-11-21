async function first(): Promise<void> {
  const label = (await import("./dynamic-reexport-barrel.ts")).label;
  console.log(label);
}
async function second(): Promise<void> {
  const render = (await import("./dynamic-reexport-barrel.ts")).render;
  console.log(render());
}
void first();
void second();
console.log("entry");
