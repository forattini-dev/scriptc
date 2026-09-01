import { createServer } from "node:net";

const host = "127.0.0.1";
const first = createServer();
const second = createServer();

first.listen({ port: 0, host, reusePort: true }, () => {
  const port = first.address().port;
  second.listen({ port, host, reusePort: true }, () => {
    console.log("shared", first.address().port === second.address().port);
    second.close(() => first.close());
  });
});
