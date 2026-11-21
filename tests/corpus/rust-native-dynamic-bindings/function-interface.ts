const pending: { resolve: Function } = {
  resolve: (value: number) => console.log(value + 1),
};

pending.resolve(41);
