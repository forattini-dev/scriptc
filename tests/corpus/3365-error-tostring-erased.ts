class AppError extends Error {
  tag = 7;
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }

  override toString(): string {
    return `${this.name} | ${this.message}`;
  }
}

function renderUnknown(value: unknown): void {
  console.log(String(value));
  console.log(`${value}`);
}

const error = new AppError("first");
const erased: unknown = error;
if (erased instanceof AppError) console.log(erased === error, erased.tag);
renderUnknown(error);
error.message = "later";
renderUnknown(error);
renderUnknown("plain");

try {
  throw error;
} catch (caught) {
  console.log(String(caught));
  console.log(`${caught}`);
  if (caught instanceof Error) console.log(caught.toString());
  renderUnknown(caught);
}

try {
  throw "primitive";
} catch (caught) {
  console.log(String(caught));
}
