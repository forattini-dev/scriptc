// Modern ESM CLIs use import.meta.url to distinguish direct execution from
// import. A native executable has no source-module loader, so its entry URL
// names the executable just as process.argv[1] does.
const invokedDirectly = process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

console.log(invokedDirectly);
console.log(new URL(import.meta.url).protocol);
