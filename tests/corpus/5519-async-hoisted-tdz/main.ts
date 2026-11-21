async function run() {
  function read() {
    return current();
  }
  try {
    read();
  } catch (error) {
    console.log("before", error instanceof ReferenceError);
  }
  await Promise.resolve();
  let value: string | undefined;
  function current() {
    return value;
  }
  console.log("after", read() === undefined);
  value = "ready";
  console.log("updated", read());
}

void run();
