function delayed(value: string): Promise<string> {
  return new Promise<string>((resolve) => setTimeout(() => resolve(value), 5));
}

function failing(message: string): Promise<number> {
  return new Promise<number>(() => {
    throw new Error(message);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const recovered = await failing("boom").then(
    (value) => `unexpected:${value}`,
    async (error) => {
      const prefix = await delayed("handled");
      return `${prefix}:${describe(error)}`;
    },
  );
  console.log(recovered);

  const fulfilled = await delayed("ok").then(
    (value) => `${value}:kept`,
    async () => delayed("unexpected rejection"),
  );
  console.log(fulfilled);
}

main();
