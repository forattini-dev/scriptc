function mapValue(value: number, index: number, source: number[]): unknown {
  console.log("visit", value, index, source.length);
  if (value === 0) {
    source.push(99);
    const sparse: any[] = ["first", "middle", "third"];
    delete sparse[1];
    return sparse;
  }
  if (value === 1) return 42;
  if (value === 2) return [["nested"], "end"];
  return undefined;
}

const values = [0, 1, 2, 3];
const result = values.flatMap(mapValue);
console.log("result", JSON.stringify(result));
console.log("presence", result.length, Object.hasOwn(result, 5), result[5] === undefined);
console.log("source length", values.length);
