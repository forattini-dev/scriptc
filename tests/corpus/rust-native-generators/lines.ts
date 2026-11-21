function* linesFromString(input: string): Generator<string, void, undefined> {
  let start = 0;
  while (true) {
    const end = input.indexOf("\n", start);
    if (end === -1) {
      yield input.slice(start);
      return;
    }
    yield input.slice(start, end);
    start = end + 1;
  }
}

for (const line of linesFromString("one\ntwo\nthree")) {
  console.log(line);
}
