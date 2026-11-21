function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

console.log(now() >= 0);
