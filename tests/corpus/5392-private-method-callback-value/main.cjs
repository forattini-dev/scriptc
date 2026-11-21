class NativeLookup {
  constructor(options) {
    this.lookup = options.lookup ?? this.#defaultLookup;
  }

  #defaultLookup(value) {
    return `native:${value}`;
  }

  run(value) {
    return this.lookup(value);
  }
}

console.log(new NativeLookup({}).run('ok'));
console.log(new NativeLookup({ lookup: value => `custom:${value}` }).run('ok'));
