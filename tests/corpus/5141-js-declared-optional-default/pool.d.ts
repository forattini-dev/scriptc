export interface PoolOptions {
  initialSize?: number;
  maxSize?: number;
}

export declare function createPool(
  factory: () => number,
  reset: (value: number) => void,
  options?: PoolOptions,
): number;
