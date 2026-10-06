class Base { value = 1; }
function factory(value: number) { return class extends Base { own = value; }; }
function repeated(): number { const Result = factory(2); return new Result().own; }
console.log(repeated());
