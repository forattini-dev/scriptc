const values = ["alpha", null, undefined, 2];
const dynamic = /** @type {any} */ (values);
console.log(String(dynamic.join("|")));
console.log(String(dynamic.join()));
