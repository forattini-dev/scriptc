function caughtMessage(): string {
  try {
    throw new Error("asserted-native-error");
  } catch (error) {
    return (error as Error).message;
  }
}

console.log(caughtMessage());
