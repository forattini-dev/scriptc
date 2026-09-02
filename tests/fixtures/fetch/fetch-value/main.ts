type FetchLike = typeof fetch;

async function readText(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url);
  return await response.text();
}

const configured: FetchLike | undefined = undefined;
console.log(await readText(configured ?? fetch, `${process.argv[2]}/text`));
