function balance(asyncValue: boolean): string | null | Promise<string | null> {
  return asyncValue ? Promise.resolve("async") : "sync";
}

async function read(asyncValue: boolean): Promise<string | null> {
  return (await balance(asyncValue)) ?? null;
}

read(false).then((value) => console.log(value ?? "null"));
read(true).then((value) => console.log(value ?? "null"));
