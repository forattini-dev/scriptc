// @rust-only
// The value forms that fill a generic member slot in real service literals:
// a module generic function DECLARATION (`with: json`, shorthand, cast to the
// member type), a contextually typed arrow without its own type parameters,
// and a self-referencing arrow. Each call dispatches through the stored
// family value at its own instantiation.
interface Codec {
  readonly name: string;
  readonly encode: <T>(value: T) => string;
  readonly pipe: <A>(f: (self: Codec) => A) => A;
}

function json<T>(value: T): string {
  return `json:${typeof value}`;
}

function tagged<T>(value: T): string {
  return `tagged:${String(value)}`;
}

const codec: Codec = { name: "codec", encode: json, pipe: (f) => f(codec) };
console.log(codec.encode(1), codec.encode("s"), codec.pipe((c) => c.encode(true)));

const casted: Codec = { name: "casted", encode: tagged as Codec["encode"], pipe: <A>(f: (self: Codec) => A): A => f(casted) };
console.log(casted.encode(2), casted.pipe((c) => c.encode("x")), casted.pipe((c) => c === casted));

function shorthandCodec(): Codec {
  const pipe = <A>(f: (self: Codec) => A): A => f(result);
  const result: Codec = { name: "shorthand", encode: json, pipe };
  return result;
}
const codecs: Codec[] = [codec, casted, shorthandCodec()];
console.log(codecs.map((c) => c.encode(3)).join(" "), codecs.map((c) => c.pipe((s) => s.encode([1]))).join(" "));

interface Hooks {
  readonly name: string;
  readonly serial: <D extends { type: string }>(definition: D, callback: (definition: D) => void) => number;
}
let registered = 0;
const hooks: Hooks = {
  name: "hooks",
  serial: (definition, callback) => {
    registered++;
    callback(definition);
    return registered;
  },
};
console.log(hooks.serial({ type: "t", n: 1 }, (d) => console.log(d.type, d.n)));
console.log(hooks.serial({ type: "u", flag: true }, (d) => console.log(d.type, d.flag)));
