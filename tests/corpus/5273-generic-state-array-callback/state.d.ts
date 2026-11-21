export declare function useState<T>(
  initial: T,
): [() => T, (value: T | ((previous: T) => T)) => void];
