// @ts-nocheck
async function probe(): Promise<void> {
  if (Date.now() < 0) {
    const response = await globalThis.fetch("https://example.invalid/global")
    console.log(response.status)
  }
  console.log(globalThis.fetch === fetch)
}

void probe()
