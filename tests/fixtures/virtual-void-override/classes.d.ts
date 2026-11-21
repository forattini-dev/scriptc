export class Base {
  constructor(log: string[]);
  run<T>(value: T): void;
}
export class Child extends Base {
  run<T>(value: T): void;
}
