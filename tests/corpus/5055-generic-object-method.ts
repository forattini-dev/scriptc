const api = {
  identity<T>(value: T): T {
    return value;
  },
};

console.log(api.identity(7));
console.log(api.identity("stable"));
