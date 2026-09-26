let sawDisconnect = false;
process.once("disconnect", () => {
  sawDisconnect = true;
});

process.once("message", async (message: { kind: string; value: number }) => {
  await Promise.resolve();
  process.send?.(
    {
      argv: process.argv.slice(2),
      connected: process.connected,
      cwd: process.cwd().endsWith("2946-child-fork-ipc"),
      env: process.env.IPC_FIXTURE,
      kind: message.kind === "ping" ? "pong" : "unexpected",
      value: message.value,
    },
    (error) => {
      if (error) process.exit(2);
      setTimeout(() => {
        process.exitCode = sawDisconnect ? 0 : 3;
      }, 5);
      process.disconnect();
    },
  );
});
