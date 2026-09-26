import * as http from "node:http";

const server = http.createServer((incoming, outgoing) => {
  incoming.resume();
  outgoing.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const early = http.request({ host: "127.0.0.1", port });
  console.log("early before", early.aborted, early.destroyed);
  early.on("socket", () => console.log("early socket"));
  early.on("error", (error) => console.log("early error", error.message));
  early.on("close", () => console.log("early close", early.aborted, early.destroyed));
  early.on("abort", () => {
    console.log("early abort", early.aborted, early.destroyed);
    const late = http.get({ host: "127.0.0.1", port });
    late.on("socket", () => {
      console.log("late socket", late.aborted, late.destroyed);
      late.abort();
      console.log("late after", late.aborted, late.destroyed);
    });
    late.on("abort", () => console.log("late abort", late.aborted, late.destroyed));
    late.on("error", (error) => console.log("late error", error.message));
    late.on("close", () => {
      console.log("late close", late.aborted, late.destroyed);
      server.close();
    });
  });
  early.abort();
  console.log("early after", early.aborted, early.destroyed);
});
