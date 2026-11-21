// @ts-nocheck
class CellBuffer {
  constructor(width) {
    this.width = width;
  }

  diffRects(target) {
    return this.width + target.width;
  }

  *[Symbol.iterator]() {
    yield this.width;
  }
}

const front = new CellBuffer(7);
const back = new CellBuffer(11);
console.log(front.diffRects(back));
