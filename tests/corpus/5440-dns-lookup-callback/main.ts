import { lookup } from "node:dns";

console.log("before");

lookup("127.0.0.1", (error, address, family) => {
  console.log("default", error === null, address, family);
});

lookup("::1", 6, (error, address, family) => {
  console.log("family", error === null, address, family);
});

const allCallback: any = (error: any, addresses: any) => {
  console.log(
    "all",
    error === null,
    addresses.length,
    addresses[0].address,
    addresses[0].family,
  );
};

lookup("127.0.0.1", { family: 4, all: true, order: "ipv4first" }, allCallback);

console.log("after");
