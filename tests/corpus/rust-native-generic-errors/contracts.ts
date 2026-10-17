// @rust-only
// @no-engine
import { ResponseError } from "./library.js";
const request = { url: "/graphql", method: "POST" };
const payload = { answer: 42 };
const response = { data: payload, errors: [{ message: "missing" }] };
const fault = new ResponseError(request, response);
console.log("error", fault.name, fault.message, fault instanceof Error, fault instanceof ResponseError);
console.log("identity", fault.request === request, fault.response === response, fault.data === payload, fault.errors === response.errors);
console.log("fields", fault.data.answer, fault.errors[0].message, fault.request.url);
const scalar = new ResponseError(request, { data: 17, errors: [{ message: "second" }] });
console.log("generic", scalar.data, scalar.errors[0].message, fault.data.answer);
const Alias = ResponseError;
const aliased = new Alias(request, { data: "aliased", errors: [{ message: "third" }] });
console.log("alias", aliased.data, aliased instanceof Alias, Alias === ResponseError);
