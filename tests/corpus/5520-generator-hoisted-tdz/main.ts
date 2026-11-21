function* run() {
  function read() {
    return current();
  }
  try {
    read();
  } catch (error) {
    console.log("before", error instanceof ReferenceError);
  }
  yield "paused";
  let value: string | undefined;
  function current() {
    return value;
  }
  console.log("after", read() === undefined);
  value = "ready";
  yield read();
}

const iterator = run();
console.log("first", iterator.next().value);
console.log("second", iterator.next().value);
