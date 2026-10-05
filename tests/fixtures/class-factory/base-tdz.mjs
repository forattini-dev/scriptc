function factory() { return class extends Base {}; }
class Result extends factory() {}
class Base {}
console.log(new Result());
