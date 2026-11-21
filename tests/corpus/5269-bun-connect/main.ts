async function main(): Promise<void> {
const answered = await new Promise<boolean>((resolve) => {
  let settled = false;
  const finish = (value: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(false), 1_000);
  Bun.connect({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.end();
        finish(true);
      },
      data() {},
      close() {},
      error() {
        finish(false);
      },
      connectError() {
        finish(false);
      },
    },
  }).catch(() => finish(false));
});

console.log(answered);
}

main();
