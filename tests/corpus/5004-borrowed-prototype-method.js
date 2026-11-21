// @ts-nocheck
class MapLike {
  add(value) {
    return this;
  }
}

class SeqLike {
  constructor() {
    this.add = MapLike.prototype.add.bind(this);
  }
}

const seq = new SeqLike();
seq.add("native");
console.log(true);
