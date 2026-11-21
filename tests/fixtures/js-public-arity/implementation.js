export class Box {
  constructor(value) { this.value = value; }
  brand() { return this.value; }
  collect() { return arguments.length; }
  prefix(value) { return value + this.value; }
}
export function unused() { return "ok"; }
export function usesArguments() { return arguments.length; }
export function first(value) { return value; }
