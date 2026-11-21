const target: any = { value: 2 };

Object.defineProperties(target, {
  doubled: {
    value: () => target.value * 2,
    enumerable: true,
  },
  empty: {
    get() {
      return target.value === 0;
    },
  },
});

console.log("defineProperties", target.doubled(), target.empty, Object.keys(target).join(","));
