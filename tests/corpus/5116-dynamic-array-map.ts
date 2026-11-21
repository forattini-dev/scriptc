const source: any = [2, 4, 6];
const result: any = source.map((value: number, index: number) => value + index);
console.log(Number(result.length));
console.log(Number(result[0]));
console.log(Number(result[1]));
console.log(Number(result[2]));

const sparse: any = [10, 20, 30];
delete sparse[1];
let visits = "";
const mapped: any = sparse.map((value: number, index: number, array: any) => {
  visits += String(index);
  if (index === 0) {
    array[2] = 40;
    array[3] = 50;
  }
  return value + 1;
});
console.log(visits);
console.log(Number(mapped.length));
let count = 0;
mapped.map(() => { count++; return 0; });
console.log(count);
console.log(Number(mapped[0]));
console.log(Number(mapped[2]));
