const callHasInstance = Function.call.bind(Function.prototype[Symbol.hasInstance])

class Base {}
class Child extends Base {}
class Other {}

const child = new Child()
console.log(callHasInstance(Child, child))
console.log(callHasInstance(Base, child))
console.log(callHasInstance(Other, child))
