// @rust-only
// @no-engine
export {};
type Data = { value: number };
class Box {
  #data: Data;
  #peer: Box | undefined;
  #callback: (() => Box) | undefined;
  #initialCallback: () => number = () => 17;
  constructor(data: Data) { this.#data = data; }
  get data(): Data { return this.#data; }
  link(other: Box): void { this.#peer = other; const self = this; this.#callback = () => self; }
  peer(other: Box): boolean { return this.#peer === other; }
  captured(): boolean { const read = this.#callback; if (read) return read() === this; return false; }
  initialized(): number { return this.#initialCallback(); }
}
function cycle(value: number): void {
  const data = { value };
  const first = new Box(data);
  const second = new Box(data);
  first.link(second);
  second.link(first);
  console.log("identity", first.data === data, second.data === first.data, first.peer(second), first.captured(), first.initialized());
  first.data.value = value + 1;
  console.log("shared", data.value, second.data.value);
}
cycle(1);
cycle(10);
