export class Box {
  #value: number;
  constructor(value: number) { this.#value = value; }
  read(): number { return this.#value; }
}
export function make(value: number): Box { return new Box(value); }
