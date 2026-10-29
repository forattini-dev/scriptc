const warn = console.warn.bind(console);
const log = console.log.bind(console);
const error = console.error.bind(console);
const alias = warn;
log("bound log");
warn("bound warning");
error("bound error");
console.log("identity", warn === alias, warn === console.warn);
function emit(message: string): void { console.log(message); }
function shadow(console: { warn: (message: string) => void }): void {
  const local = console.warn.bind(console);
  local("shadowed console");
}
shadow({ warn: emit });
