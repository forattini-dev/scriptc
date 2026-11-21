export {};

async function main(): Promise<void> {
  const child = Bun.spawn(["node", "-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  if (child.stdin) {
    child.stdin.write("native stdin");
    child.stdin.end();
  }

  console.log((await new Response(child.stdout).text()).trim());
  console.log(await child.exited);
}

void main();
