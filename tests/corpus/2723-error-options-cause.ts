const original: unknown = new TypeError("socket unavailable");
const wrapped = new Error("reconnect exhausted", { cause: original });

console.log(
  wrapped.name,
  wrapped.message,
  wrapped.cause === original,
  wrapped.cause instanceof TypeError,
);
