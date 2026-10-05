class Base { value = 1; }
function factory(value = 2) { return class extends Base { own = value; }; }
class Result extends factory() {}
console.log(new Result().own);
