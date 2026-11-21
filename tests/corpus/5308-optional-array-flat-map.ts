const offered = ['node@22', 'bun@1', 'deno@2'];
const preferences: { runtimes: string[] | undefined } = {
  runtimes: ['bun@latest', 'missing@1', 'node@lts'],
};
const absent: { runtimes: string[] | undefined } = { runtimes: undefined };

function selected(owner: { runtimes: string[] | undefined }): string {
  const runtimes = owner.runtimes?.flatMap(id => {
    const runtime = offered.find(value => value.split('@')[0] === id.split('@')[0]);
    return runtime ? [runtime] : [];
  });
  return runtimes?.join('|') ?? 'none';
}

console.log(selected(preferences));
console.log(selected(absent));
