import { Order } from "./order.js";
const order = new Order();
console.log("values", order["01"], order["2"], order.first, order["10"]);
console.log("keys", Object.keys(order as any).join(","));
