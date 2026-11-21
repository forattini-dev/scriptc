export {};

async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function hasPid(child: Bun.Subprocess): boolean {
  return child.pid > 0;
}

async function main(): Promise<void> {
  const child = Bun.spawn(["node", "-e", "process.stdout.write('streamed output')"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin?.end();
  console.log(hasPid(child));
  console.log((await capture(child.stdout)).trim());
  console.log(await child.exited);
  await child.stderr.getReader().cancel();
  await Promise.all([Promise.resolve(), Promise.resolve()]);
}

void main();
