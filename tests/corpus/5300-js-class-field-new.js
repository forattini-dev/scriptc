// @ts-nocheck
class CellBuffer {
  constructor(width) {
    this.width = width;
  }

  *[Symbol.iterator]() {
    yield this.width;
  }
}

class DoubleBuffer {
  front;

  constructor(width) {
    this.front = new CellBuffer(width);
  }

  frontWidth() {
    return this.front.width;
  }

  getFrontBuffer() {
    return this.front;
  }
}

const buffers = new DoubleBuffer(17);
console.log(buffers.frontWidth(), buffers.getFrontBuffer().width);
