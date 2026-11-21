async function main(): Promise<void> {
  try {
    await import("./tdz-a.ts");
  } catch (error) {
    console.log(error instanceof ReferenceError);
  }
}

void main();
