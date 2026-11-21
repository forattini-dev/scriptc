Object.defineProperty(exports, "__esModule", { value: true });

class Base {
  constructor(value) {
    this.value = value;
  }

  read() {
    return this.value;
  }
}

exports.default = Base;
