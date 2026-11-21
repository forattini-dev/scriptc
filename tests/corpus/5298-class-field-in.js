// @ts-nocheck
class Pair {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}

class Store {
  add(pair) {
    return !pair || typeof pair !== 'object' || !('key' in pair) ? 'wrapped' : pair.value;
  }
}

console.log(new Store().add(new Pair('answer', 42)));
