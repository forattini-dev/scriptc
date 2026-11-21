const Base = require('./base.cjs')

class Child extends Base {
  describe() {
    return `child:${this.value}`
  }
}

const child = new Child(42)
console.log(child.describe())
console.log(child instanceof Child)
