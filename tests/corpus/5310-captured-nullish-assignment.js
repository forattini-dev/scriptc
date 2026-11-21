// @ts-nocheck
function collect() {
  let firstError;
  const attempt = operation => {
    try {
      operation();
    } catch (error) {
      firstError ??= error;
    }
  };

  attempt(() => { throw 'first'; });
  attempt(() => { throw 'second'; });
  return firstError;
}

console.log(collect());
