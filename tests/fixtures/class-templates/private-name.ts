function make(tag: string) {
  return class { #tag = tag; read(): string { return this.#tag; } };
}
function run(): string { return new (make("a"))().read(); }
console.log(run());
