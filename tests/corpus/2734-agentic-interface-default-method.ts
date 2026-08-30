interface LeaseRuntime {
  renew(id: string, ttlMs?: number): Promise<string | null>;
}

function createRuntime(): LeaseRuntime {
  return {
    async renew(id, ttlMs = 30): Promise<string | null> {
      if (id !== "live") return null;
      return id + ":" + ttlMs;
    },
  };
}

async function main(): Promise<void> {
  const runtime = createRuntime();
  console.log(await runtime.renew("live"));
  console.log(await runtime.renew("live", 90));
  console.log(await runtime.renew("gone"));
}

void main();
