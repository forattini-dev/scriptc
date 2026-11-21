type Options = { excludeRids?: Iterable<number> };
function collect(options: Options = {}) {
  return new Set(options.excludeRids ?? []);
}
console.log(collect().size, collect({ excludeRids: [1, 2, 1] }).size);
