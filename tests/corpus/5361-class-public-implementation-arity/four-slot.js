class FourSlot {
  constructor (first, second, third, fourth) {
    this.first = first
    this.second = second
    this.third = third
    this.fourth = fourth
  }

  describe () {
    return `${this.first},${this.second},${this.third},${this.fourth}`
  }
}

module.exports = FourSlot
