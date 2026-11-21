// @rust-only
// @no-engine
type Defaults = { offset: number };
interface Endpoint {
  (value: number): number;
  DEFAULTS: Defaults;
  defaults: (offset: number) => Endpoint;
  merge: (value: number) => number;
  parse: (value: number) => number;
}
function parse(value: number): number { return value * 2; }
function invoke(defaults: Defaults, value: number): number { return defaults.offset + parse(value); }
function withDefaults(old: Defaults, offset: number): Endpoint {
  const DEFAULTS = { offset: old.offset + offset };
  const endpoint = invoke.bind(null, DEFAULTS);
  return Object.assign(endpoint, {
    DEFAULTS,
    defaults: withDefaults.bind(null, DEFAULTS),
    merge: invoke.bind(null, DEFAULTS),
    parse,
  });
}
const endpoint = withDefaults({ offset: 1 }, 2);
const alias = endpoint;
console.log("callable", endpoint(4), endpoint.merge(5), endpoint.parse(3), endpoint.DEFAULTS.offset, endpoint === alias);
const child = alias.defaults(10);
console.log("defaults", child(2), child.DEFAULTS.offset, child !== endpoint);
const plain: (value: number) => number = endpoint;
console.log("plain", plain(4), plain === endpoint);
const erased: any = endpoint;
const erasedResult: number = erased(4);
const erasedOffset: number = erased.DEFAULTS.offset;
console.log("erased", erasedResult, erasedOffset, erased === endpoint);
const rebound = endpoint.bind(null, 6);
const sibling = endpoint.bind(null, 6);
console.log("rebound", rebound(), rebound !== sibling);
const replacement = { offset: 20 };
const assigned = Object.assign(endpoint, { DEFAULTS: replacement });
console.log("assign", assigned === endpoint, alias.DEFAULTS.offset, endpoint(4));
let effects = 0;
function mark(value: number): number { effects = effects + 1; console.log("effect", value); return value; }
function sum(a: number, b = 5): number { return a + b; }
const bound = sum.bind(mark(0), mark(2));
console.log("bind order", bound(), bound(0), effects);
const decoratedDefault = Object.assign(sum.bind(null, 2), { tag: "sum" });
console.log("bound optional metadata", decoratedDefault(), decoratedDefault(0), decoratedDefault.tag);
