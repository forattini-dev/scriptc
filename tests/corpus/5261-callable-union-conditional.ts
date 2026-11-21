function invoke(value: string | (() => number)): string | number {
  const callable = typeof value === "function" ? value : (): string => value;
  return callable();
}

console.log(invoke("plain"));
console.log(invoke((): number => 42));
