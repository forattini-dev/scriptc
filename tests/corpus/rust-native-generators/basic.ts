function* values(): Generator<string, void, undefined> {
  yield "a";
  yield "b";
}

for (const value of values()) {
  console.log(value);
}
