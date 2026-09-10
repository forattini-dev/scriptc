export const value: unknown = new Proxy({ present: undefined }, {
  has(_target, key) {
    if (key === 'boom') throw new Error('has trap');
    return key === 'present';
  },
});
