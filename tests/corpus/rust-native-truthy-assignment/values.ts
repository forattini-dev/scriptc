// @ts-nocheck
function choose(value: string | undefined): string {
  let current = "initial";
  const candidate = value;
  if (!candidate) throw new Error("missing");
  current = candidate;
  return current;
}
console.log("value", choose("ready"));
for (const value of [undefined, ""]) {
  try { choose(value); }
  catch (error) { console.log("guard", (error as Error).message); }
}
function afterMutation(): string {
  let current = "initial";
  let candidate: string | undefined = "before";
  const clear = (): void => { candidate = undefined; };
  if (!candidate) throw new Error("missing");
  clear();
  current = candidate;
  return current;
}
console.log("mutation", afterMutation());
