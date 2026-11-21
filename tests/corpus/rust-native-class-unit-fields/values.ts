// @rust-only
// @no-engine
export {};

interface ResponseShape {
  readonly timings: undefined;
  readonly connection: undefined;
}

class QueuedResponse implements ResponseShape {
  public readonly timings = undefined;
  public readonly connection = undefined;
  public readonly status = "queued";
}

const response = new QueuedResponse();
console.log(response.timings === undefined, response.connection === undefined, response.status);

class NullField {
  readonly value = null;
}
const nullField = new NullField();
console.log(nullField.value === null);
