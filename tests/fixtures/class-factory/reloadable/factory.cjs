class Base { value = 1; }
function factory(value) { return class extends Base { own = value; }; }
const Result = factory(2);
module.exports = new Result().own;
