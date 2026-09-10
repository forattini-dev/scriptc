// @dynamic
// Clone cycles, maps and DOMException; validate missing/invalid arguments.
console.log(__island_eval(`(() => {
        const grab = (f) => { try { return String(f()); } catch (e) { return e.name + '/' + (e.code || '') + ': ' + e.message; } };
        const cyc = { n: 1 }; cyc.self = cyc;
        const cloned = structuredClone(cyc);
        const m = structuredClone(new Map([['k', [1, 2]]]));
        const dx = structuredClone(new DOMException('t', 'DataCloneError'));
        return [
          cloned !== cyc && cloned.self === cloned && cloned.n === 1,
          m.get('k').join(','),
          dx.name + ':' + dx.message + ':' + (dx instanceof DOMException),
          grab(() => structuredClone()),
          grab(() => structuredClone(undefined, '')),
          grab(() => structuredClone(undefined, { transfer: '' })),
          grab(() => structuredClone({}, { transfer: { *[Symbol.iterator]() {} } })) === '[object Object]',
          grab(() => structuredClone(() => {})),
        ].join(' | ');
      })()`));
console.log(__island_eval(`(() => {
  const marker = new RangeError('iterator marker');
  const transfers = [
    { get [Symbol.iterator]() { throw marker; } },
    { [Symbol.iterator]() { throw marker; } },
    { [Symbol.iterator]() { return { next() { throw marker; } }; } },
  ];
  const results = transfers.map(transfer => {
    try { structuredClone({}, { transfer }); return false; }
    catch (error) { return error === marker; }
  });
  const exception = new DOMException('clone', 'DataCloneError');
  const pair = structuredClone([exception, exception]);
  results.push(pair[0] === pair[1], pair[0] !== exception, pair[0] instanceof DOMException);
  return results.join('|');
})()`));
