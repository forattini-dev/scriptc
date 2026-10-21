// @rust-only
// @no-engine
export {};
type Data = { value: number };
class Box {
  #data: Data;
  #peer: Box | undefined;
  constructor(value: Data) { this.#data = value; }
  #read(): Data { return this.#data; }
  #store(other: Box): void { this.#peer = other; }
  data(): Data { return this.#read(); }
  link(other: Box): void { this.#store(other); }
  closure(): () => Data { const self = this; return () => self.#read(); }
}
function cycle(): void {
  const data = { value: 1 };
  const first = new Box(data), second = new Box(data);
  first.link(second); second.link(first);
  const read = first.closure();
  console.log(first.data() === data, second.data() === read());
  read().value = 7;
  console.log(second.data().value);
}
cycle();
