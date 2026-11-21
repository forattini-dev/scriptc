function debug(head: string, ...args: unknown[]): void {
  console.debug(head, ...args);
}

function warn(...args: unknown[]): void {
  console.warn(...args);
}

debug("debug", 1, true, "tail");
warn("warn", 2, false);
console.log(...["formatted %s", "value"]);
