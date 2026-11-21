function update(values: number[]): number {
  values[0] = 7;
  return values[1];
}

const erased: any[] = [1, 2];
const alias = erased;
const result = update(erased);
if (result !== 2 || alias[0] !== 7) throw new Error("array view lost identity");
console.log("2 7");
