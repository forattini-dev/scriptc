let fallbackCalls = 0;

function fallback(): number {
  fallbackCalls++;
  return 0;
}

function pick(value: boolean | undefined): boolean | number {
  return value ?? fallback();
}

console.log(pick(true), fallbackCalls);
console.log(pick(undefined), fallbackCalls);

function pickMany(value: boolean | string | undefined): boolean | string {
  return value ?? "default";
}

console.log(pickMany(true), pickMany("text"), pickMany(undefined));

function pickAfterNarrow(value: boolean | string | undefined): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value ?? "default";
}

console.log(pickAfterNarrow(true), pickAfterNarrow("text"), pickAfterNarrow(undefined));
