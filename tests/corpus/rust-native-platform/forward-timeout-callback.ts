async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
      resolve();
    }
    const onCancel = () => done();
    signal?.addEventListener("abort", onCancel, { once: true });
  });
}

async function main(): Promise<void> {
  await sleep(1);
  console.log("done");
}

void main();
