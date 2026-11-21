// @ts-nocheck
export class CellBuffer {
  constructor(width) {
    this.width = width;
  }

  [Symbol.iterator]() {
    return { next: () => ({ done: true, value: undefined }) };
  }
}

export class DoubleBuffer {
  front;

  constructor(width) {
    this.front = new CellBuffer(width);
  }

  getFrontBuffer() {
    return this.front;
  }

  frontWidthViaHelper() {
    return bufferWidth(this.getFrontBuffer());
  }
}

export function bufferWidth(buffer) {
  return buffer.width;
}
