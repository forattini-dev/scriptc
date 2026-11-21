type Options = { excludeRids?: Iterable<number> };
function* generated(): Generator<number, void, undefined> { yield 1; yield 2; yield 1; }
function collect(options: Options = {}): Set<number> { return new Set(options.excludeRids ?? []); }
function resultFor(mode: number): Set<number> {
  if (mode === 0) return collect({});
  if (mode === 1) return collect({ excludeRids: [1, 2, 1] });
  if (mode === 2) return collect({ excludeRids: new Set([1, 2, 1]) });
  return collect({ excludeRids: generated() });
}
for (let mode = 0; mode < 4; mode++) for (let action = 0; action < 4; action++) for (let round = 0; round < 2; round++) {
  try {
    const result = resultFor(mode);
    let out: string;
    if (action === 0) out = 'size:' + result.size;
    else if (action === 1) out = 'has:' + result.has(1);
    else if (action === 2) out = 'delete:' + result.delete(1) + ':' + result.size;
    else out = 'array:' + Array.from(result).join(',');
    console.log(mode, action, round, out);
  } catch (e) { console.log(mode, action, round, e instanceof TypeError ? 'TypeError' : 'other'); }
}
