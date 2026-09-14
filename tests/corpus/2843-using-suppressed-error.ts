class ThrowingResource {
  [Symbol.dispose](): void {
    throw new Error("dispose");
  }
}

try {
  using resource = new ThrowingResource();
  throw new Error("body");
} catch (error) {
  if (error instanceof Error) {
    console.log(error.name);
    console.log(error.message);
  }
}
