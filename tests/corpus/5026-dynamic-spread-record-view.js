const api = /** @type {any} */ ({ users: 7 });
/** @type {{ users: number, rest: any }} */
const result = {
  ...api,
  rest: api,
};
console.log(result.users);
console.log(result.rest === api);
