type SourceFetch = (
  input: string | { url: string },
  init: { method: string } | undefined,
) => Promise<{ status: number }>;

type TargetFetch = (
  input: string | { url: string; headers?: string },
  init: { method: string; body?: string } | undefined,
) => Promise<{ status: number; ok?: boolean }>;

interface Options {
  fetchImpl?: SourceFetch;
}

const source: SourceFetch = (_input, _init) => Promise.resolve({ status: 204 });
const options: Options = { fetchImpl: source };
const configured = {
  ...(options.fetchImpl
    ? { fetchImpl: options.fetchImpl as unknown as TargetFetch }
    : {}),
};

console.log(typeof configured.fetchImpl);
