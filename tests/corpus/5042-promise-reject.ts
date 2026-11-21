Promise.reject(7).then(undefined, value => {
  console.log(value as number);
});
