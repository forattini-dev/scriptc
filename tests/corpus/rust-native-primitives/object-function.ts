const ObjectAlias = Object;
const fresh = ObjectAlias();
const source = { value: 1 };
const identity = ObjectAlias(source) === source;

console.log(typeof ObjectAlias, typeof fresh, identity);
