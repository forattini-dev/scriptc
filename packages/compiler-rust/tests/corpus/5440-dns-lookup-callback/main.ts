import { lookup } from "node:dns";

lookup("127.0.0.1", { all: true, family: 0, order: "ipv4first" }, (error, addresses) => {
  if (error) throw error;
  console.log(addresses.map(({ address, family }) => `${address}/${family}`).join(","));
});

lookup("127.0.0.1", (error, address, family) => {
  if (error) throw error;
  console.log(`${address}/${family}`);
});
