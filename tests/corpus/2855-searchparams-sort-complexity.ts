const params = new URLSearchParams();
const size = 16384;
for (let i = size; i > 0; i--) {
  params.append(`key${100000 + i}`, `value${i}`);
}
params.append("same", "first");
params.append("same", "second");
params.append("same", "third");

const started = performance.now();
params.sort();
if (performance.now() - started > 1000) {
  throw new Error("URLSearchParams.sort exceeded complexity budget");
}

console.log(params.size, params.get("key100001"), params.get(`key${100000 + size}`));
console.log(params.getAll("same").join(","));
