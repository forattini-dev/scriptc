// @rust-only
// @no-engine

async function value(): Promise<string> {
  return new Promise<string>((resolve) => {
    resolve("ready");
  });
}

void value().then((resolved) => console.log(resolved));
