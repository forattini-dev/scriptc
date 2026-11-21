async function decode(value: string): Promise<string> {
  return Promise.resolve(value.toUpperCase());
}

async function request(mode: number, parseBody: boolean): Promise<string> {
  let response = "";
  try {
    response = await Promise.resolve("body");
  } catch {
    return "caught";
  }

  const result = { data: "" };
  if (mode === 1) {
    result.data = await decode(response);
    throw new Error(`first:${result.data}`);
  }
  if (mode === 2) {
    result.data = await decode(response);
    throw new Error(`second:${result.data}`);
  }
  result.data = parseBody ? await decode(response) : response;
  return result.data;
}

async function main(): Promise<void> {
  console.log(await request(0, false));
  console.log(await request(0, true));
  for (const mode of [1, 2]) {
    try {
      await request(mode, true);
    } catch (error) {
      console.log((error as Error).message);
    }
  }
}

void main();
