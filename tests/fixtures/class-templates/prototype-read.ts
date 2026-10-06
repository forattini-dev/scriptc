class Base { value = 1; }
function make(tag: string) {
  return class extends Base { tag(): string { return tag; } };
}
function run(): boolean { const C = make("a"); return C.prototype instanceof Base; }
console.log(run());
