export declare class CellBuffer {
  width: number;
  constructor(width: number);
  [Symbol.iterator](): Iterator<number>;
}

export declare function render(buffer?: CellBuffer): number;
