import { createServer } from "node:net";

const ipv6 = createServer();
const ipv4 = createServer();

ipv6.listen({ port: 0, host: "::", ipv6Only: true }, () => {
  const port = ipv6.address().port;
  ipv4.listen({ port, host: "0.0.0.0" }, () => {
    console.log("split", ipv6.address().port === ipv4.address().port);
    ipv4.close(() => ipv6.close());
  });
});
