class Payload {
  [Symbol.iterator]<T>(value: T): T { return value; }
}
export function factory(): { payload: Payload } {
  return { payload: new Payload() };
}
