// @ts-nocheck
var pendingPromises = new Map();

function pending(key) {
  return pendingPromises.has(key);
}

pendingPromises.set("job", 1);
console.log(pending("job"));
