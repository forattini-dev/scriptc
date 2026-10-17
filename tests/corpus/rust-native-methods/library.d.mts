export declare class Calculator {
  value: number;
  constructor(value: number);
  add(step?: number): number;
  clear(): void;
}
export declare class Box<T> {
  value: T;
  constructor(value: T);
  get(): T;
  set(value: T): void;
}
