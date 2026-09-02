"use strict";

function identity(value) {
  return value;
}

async function run() {
  console.log("before await");
  const answer = await identity(42);
  console.log("after await", answer);
  const promised = await identity(Promise.resolve("resolved"));
  console.log("after promise", promised);
  try {
    await identity(Promise.reject(new Error("dynamic boom")));
  } catch (error) {
    console.log("caught", error.name, error.message);
  }
}

run();
console.log("sync tail");
