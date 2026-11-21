// @ts-nocheck
class Reader {
  *peek(offset = 0) {
    yield offset + 1;
    return "done";
  }

}

function* forward(reader) {
  return yield* reader.peek();
}

function* take(reader) {
  return yield* forward(reader);
}

function* parseEvents() {
  const reader = new Reader();
  return yield* take(reader);
}

const iterator = parseEvents();
const first = iterator.next();
const last = iterator.next();
console.log(String(first.value) + " " + String(first.done));
console.log(String(last.value) + " " + String(last.done));
