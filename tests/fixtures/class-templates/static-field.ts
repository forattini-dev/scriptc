function make(tag: string) {
  return class { static label = tag; };
}
function run(): string { return make("a").label; }
console.log(run());
