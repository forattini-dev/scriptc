function message(): string {
  try {
    throw new Error("native-message");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

console.log(message());
