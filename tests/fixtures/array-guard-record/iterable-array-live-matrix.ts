function consume(values: Iterable<any>, source: any[], mode: number): string {
  const output: string[] = [];
  for (const value of values) {
    output.push(value === undefined ? 'undefined' : String(value));
    if (output.length === 1) {
      if (mode === 1) source.push(3);
      if (mode === 2) source.length = 1;
      if (mode === 3) delete source[1];
      if (mode === 4) source[1] = 8;
      if (mode === 5) source.shift();
      if (mode === 6) source.unshift(0);
      if (mode === 7) { source.length = 0; source.push(7, 9); }
    }
    if (output.length > 6) break;
  }
  return output.join(',');
}
for (let round = 0; round < 4; round++) {
  for (let mode = 0; mode < 8; mode++) {
    const source: any[] = [1, 2];
    console.log(round, mode, consume(source, source, mode));
  }
}
