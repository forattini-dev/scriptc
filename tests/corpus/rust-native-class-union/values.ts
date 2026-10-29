// @rust-only
// @no-engine
class Base { value: number; constructor(value: number) { this.value = value; } }
class Extra extends Base { constructor(value: number) { super(value + 1); } }
function create(choice: typeof Base | typeof Extra, value: number): Base {
  return new choice(value);
}
const alias = create;
console.log('classes', alias(Base, 3).value, alias(Extra, 3).value);
function viaConditional(flag: boolean): Base {
  const choice: typeof Base | typeof Extra = flag ? Base : Extra;
  return new choice(10);
}
console.log('selected', viaConditional(true).value, viaConditional(false).value);
let trace = '';
function argument(): number { trace += 'a'; return 5; }
function pick(flag: boolean): typeof Base | typeof Extra { trace += 'p'; return flag ? Base : Extra; }
console.log('order', new (pick(false))(argument()).value, trace);

const instance = create(Extra, 1);
console.log('brands', instance instanceof Base, instance instanceof Extra);
let chosen: typeof Base | typeof Extra = Base;
function change(): number { chosen = Extra; return 20; }
function construct(selected: typeof Base | typeof Extra): Base { return new selected(change()); }
console.log('snapshot', construct(chosen).value, construct(chosen).value);

function fromConfig(config: { Group: typeof Base | typeof Extra }): Base {
  return new config.Group(30);
}
const config: { Group: typeof Base | typeof Extra } = { Group: Base };
console.log('config-a', fromConfig(config).value);
config.Group = Extra;
console.log('config-b', fromConfig(config).value);
