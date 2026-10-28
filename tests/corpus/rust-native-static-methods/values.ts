export {};
let count = 0;
function next(): number { count += 1; return count; }
class Utility {
  static add(a: number, b = 2): number { return a + b; }
  static show(value: number): void { console.log('show', value); }
  static countDown(value: number): number {
    return value <= 0 ? 0 : 1 + Utility.countDown(value - 1);
  }
}
console.log('default', Utility.add(next()));
console.log('explicit', Utility.add(next(), next()));
Utility.show(count);
console.log('count', count);
console.log('recursive', Utility.countDown(3));
