const Base = require('./base.cjs')

class Child extends Base {
  describe () {
    return `child:${super.describe()}`
  }
}

console.log(new Child('value').describe())
