async function result(enabled: boolean): Promise<number> {
  if (enabled) console.log("inside");
  return await Promise.resolve(3);
}

console.log("before");
void result(true).then((value) => console.log(value));
console.log("after");
