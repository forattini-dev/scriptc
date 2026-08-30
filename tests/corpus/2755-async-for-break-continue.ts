async function cycle(): Promise<string> {
  let attempts = 0;
  for (;;) {
    await Promise.resolve();
    attempts += 1;
    if (attempts < 2) continue;
    if (attempts >= 3) break;
  }
  return `done:${attempts}`;
}

console.log(await cycle());
