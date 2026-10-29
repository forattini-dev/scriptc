// @rust-only
// @no-engine
class Base { value: number; constructor(value: number) { this.value = value; } }
class Extra extends Base { constructor(value: number) { super(value + 1); } }
class Config { static Group: typeof Base | typeof Extra = Base; }
console.log('initial', new Config.Group(4).value);
Config.Group = Extra;
console.log('replacement', new Config.Group(4).value);
const alias = Config;
alias.Group = Base;
console.log('alias', new Config.Group(4).value);
let trace = '';
function argument(): number { trace += 'a'; Config.Group = Extra; return 7; }
console.log('order', new Config.Group(argument()).value, trace);
console.log('next', new Config.Group(7).value);
(Config as any).Group = 3;
try {
  new Config.Group(argument());
} catch (error) {
  console.log('invalid', error instanceof TypeError, trace);
}
