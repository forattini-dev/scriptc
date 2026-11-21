export declare class CellBuffer {
  width: number;
  constructor(width: number);
  [Symbol.iterator](): Iterator<number>;
}

export declare class DoubleBuffer {
  front: any;
  constructor(width: number);
  getFrontBuffer(): any;
  frontWidthViaHelper(): number;
}

export declare function bufferWidth(buffer: any): number;
