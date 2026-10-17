function auth(token) { return Promise.resolve({ token }); }
function hook(token, request, value, extra) { return request(value); }
var createTokenAuth = function (token) {
  return Object.assign(auth.bind(null, token), { hook: hook.bind(null, token) });
};
var pair = function (first, second) { return `${first}:${second}`; };
var empty = function () { return 17; };
export { createTokenAuth, pair, empty };
