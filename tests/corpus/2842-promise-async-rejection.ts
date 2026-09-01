function delayed(value: string): Promise<string> {
  return new Promise<string>((resolve) => setTimeout(() => resolve(value), 5));
}

function failing(message: string): Promise<number> {
  return new Promise<number>(() => {
    throw new Error(message);
  });
}

async function main(): Promise<void> {
  const recovered = await failing("boom").then(
    (value) => `unexpected:${value}`,
    async (error) => {
      const prefix = await delayed("handled");
      return error instanceof Error ? `${prefix}:${error.message}` : `${prefix}:unknown`;
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
