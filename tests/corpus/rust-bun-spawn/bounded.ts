export {};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capture(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  const text = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return value;
  })();
  return {
    text,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {}
    },
  };
}

async function bounded(): Promise<string> {
  const proc = Bun.spawn(["node", "-e", "process.stdout.write('ok')"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = capture(proc.stdout);
  const stderr = capture(proc.stderr);
  const completed = Promise.all([proc.exited, stdout.text, stderr.text]);
  const deadline = delay(100).then(() => "timeout" as const);
  const outcome = await Promise.race([completed.then(() => "exit" as const), deadline]);
  const timedOut = outcome === "timeout";
  void timedOut;
  await completed;
  return "";
}

async function main(): Promise<void> {
  console.log(await bounded());
}

void main();
