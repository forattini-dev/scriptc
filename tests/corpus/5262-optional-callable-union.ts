function invoke(
  callable: undefined | (() => string) | (() => number),
): undefined | string | number {
  return callable?.();
}

console.log(invoke(undefined));
console.log(invoke((): string => "ready"));
console.log(invoke((): number => 9));
