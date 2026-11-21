const object = {
  marker: 3,
  *values() {
    yield this.marker;
    yield this.marker + 1;
    return this.marker + 2;
  },
};
const iterator = object.values();
console.log(JSON.stringify(iterator.next()), JSON.stringify(iterator.next()), JSON.stringify(iterator.next()));
