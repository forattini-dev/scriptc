class Box { get #value(): number { return 1; } read(): number { return this.#value; } }
console.log(new Box().read());
