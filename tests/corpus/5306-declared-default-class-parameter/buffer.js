// @ts-nocheck
export class CellBuffer {
  constructor(width) {
    this.width = width;
  }

  [Symbol.iterator]() {
    return { next: () => ({ done: true, value: undefined }) };
  }
}

export function render(buffer = new CellBuffer(7)) {
  return buffer.width;
}
