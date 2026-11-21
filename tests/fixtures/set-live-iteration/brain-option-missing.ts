type Options = { excludeRids?: Iterable<number> };
function* values(): Generator<number, void, undefined> { yield 1; yield 2; yield 1; }
function collect(options: Options = {}): Set<number> { return new Set(options.excludeRids ?? []); }
for (let round = 0; round < 32; round++) {
  try {
    const result = collect({});
    const before = result.size;
    const has = result.has(1);
    const rendered = Array.from(result).join(',');
    const deleted = result.delete(1);
    console.log(round, before, has, rendered, deleted, result.size);
  } catch (e) { console.log(round, e instanceof TypeError ? 'TypeError' : 'other'); }
}
