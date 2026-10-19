console.log("counter init");
export let count: number = 1;
export function set(value: number): void { count = value; }
export function read(): number { return count; }
// Storing a namespace must not demand unused generic implementations.
export function unused<T>(value: T): T { return value; }
export let operation: (value: number) => number = value => value + 1;
export function replaceOperation(): number { operation = value => value + 100; return 3; }
