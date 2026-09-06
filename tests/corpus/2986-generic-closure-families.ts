// Generic function VALUES compiled as closure families: a factory returning a generic closure (the effect
// `tags.make("location")` shape, implemented as a plain arrow cast into the generic slot), a generic arrow
// with its own type parameters, and both instantiated at several argument types.
interface Make {
  <T>(value: T, label: string): { value: T; label: string; tag: string };
}

function makeTag(tag: string): Make {
  const prefix = tag.toUpperCase();
  return ((value, label) => ({ value, label: prefix + ":" + label, tag })) as Make;
}

const location = makeTag("location");
const global = makeTag("global");

const a = location(42, "line");
const b = location("src/main.ts", "file");
const c = global(true, "flag");
console.log(a.value + 1, a.label, a.tag);
console.log(b.value.length, b.label, b.tag);
console.log(c.value, c.label, c.tag);

const pair = <A, B>(x: A, y: B): string => `${String(x)}/${String(y)}`;
const held: <A, B>(x: A, y: B) => string = pair;
console.log(pair(1, "two"), pair(true, 3), held("a", 4));

let seen = 0;
function counting(step: number): Make {
  return ((value, label) => {
    seen += step;
    return { value, label: label + "#" + String(seen), tag: "count" };
  }) as Make;
}
const one = counting(1);
const ten = counting(10);
console.log(one(1, "a").label, ten("x", "b").label, one(2, "c").label, seen);
