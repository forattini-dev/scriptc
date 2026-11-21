async function main(): Promise<void> {
  const response = new Response("queued ✓", {
    status: 202,
    statusText: "Accepted",
    headers: {
      "Content-Type": "text/plain",
      "X-Queue-Status": "queued",
    },
  });

  console.log(
    response.status,
    response.statusText,
    response.ok,
    response.headers.get("content-type"),
    response.headers.get("x-queue-status"),
  );
  console.log(await response.text());

  const empty = new Response();
  console.log(empty.body === null, await empty.text());
}

void main();
