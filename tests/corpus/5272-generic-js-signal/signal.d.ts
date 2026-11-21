export declare class Signal<T> {
  constructor(initialValue: T);
  get value(): T;
  set value(next: T);
}

export declare function createSignal<T>(initialValue: T): [() => T, (value: T) => void];
