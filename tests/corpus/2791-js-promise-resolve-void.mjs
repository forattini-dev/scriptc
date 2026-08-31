// @dynamic
async function settle() {
  await new Promise((resolve) => {
    queueMicrotask(() => resolve());
  });
  console.log("settled");
}

void settle();
