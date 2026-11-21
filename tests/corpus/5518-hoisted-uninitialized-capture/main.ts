function makeReader() {
  function read() {
    return current();
  }

  let value: string | undefined;

  function current() {
    return value ?? "empty";
  }

  const before = read();
  value = "updated";
  return `${before}:${read()}`;
}

console.log(makeReader());

function checkTemporalDeadZone() {
  function readEarly() {
    return readValue();
  }
  function writeEarly() {
    writeValue();
  }
  function typeofEarly() {
    return typeOfValue();
  }
  try {
    readEarly();
  } catch (error) {
    console.log("early read", error instanceof ReferenceError, (error as Error).message);
  }
  try {
    writeEarly();
  } catch (error) {
    console.log("early write", error instanceof ReferenceError);
  }
  try {
    typeofEarly();
  } catch (error) {
    console.log("early typeof", error instanceof ReferenceError);
  }
  let value: string | undefined;
  function readValue() {
    return value;
  }
  function writeValue() {
    value = writeInput();
  }
  function typeOfValue() {
    return typeof value;
  }
  function writeInput() {
    console.log("write input");
    return "set";
  }
  console.log("initialized", readEarly() === undefined);
  writeEarly();
  console.log("written", readEarly());
}

checkTemporalDeadZone();
