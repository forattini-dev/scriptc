class Base {
  constructor(value) {
    this.value = value
  }

  describe() {
    return `base:${this.value}`
  }
}

module.exports = Base
