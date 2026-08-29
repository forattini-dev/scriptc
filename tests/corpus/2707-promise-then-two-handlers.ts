async function fulfilled(value: string): Promise<string> {
  return value;
}

async function rejected(message: string): Promise<string> {
  throw new Error(message);
}

async function main(): Promise<void> {
  const a = await fulfilled("ok").then(
    (value) => value + ":fulfilled",
    () => "wrong-rejection",
  );
  console.log(a);

  const b = await rejected("source").then(
    () => "wrong-fulfillment",
    (error: unknown) => error instanceof Error ? `caught:${error.message}` : "caught:other",
  );
  console.log(b);

  const c = await fulfilled("handler").then(
    (value): string => {
      throw new Error(value);
    },
    () => "same-then-must-not-catch",
  ).catch((error) => error instanceof Error ? `later:${error.message}` : "later:other");
  console.log(c);

  const d = await rejected("replacement").then(
    (value) => value,
    (): string => {
      throw new Error("handler-rejected");
    },
  ).catch((error) => error instanceof Error ? error.message : "other");
  console.log(d);
}

main();
