class Base { value = 1; }
function factory(value: number) { return class extends Base { own = value; }; }
const before = 1, Result = factory(2);
console.log(before, new Result().own);
