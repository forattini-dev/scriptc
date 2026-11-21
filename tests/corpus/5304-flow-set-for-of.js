// @ts-nocheck
class Holder {
  scratch = null;

  sum() {
    this.scratch = new Set([1, 2, 3]);
    const values = this.scratch;
    this.scratch = null;
    let total = 0;
    for (const value of values) {
      total += value;
    }
    return total;
  }
}

console.log(new Holder().sum());
