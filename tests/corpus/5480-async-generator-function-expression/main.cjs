"use strict";

async function run() {
  const captured = [1, 2];
  const action = async function * () {
    yield * captured;
    yield 3;
  };

  const values = [];
  for await (const value of action()) {
    values.push(value);
  }
  console.log(values.join("|"));
}

run();
