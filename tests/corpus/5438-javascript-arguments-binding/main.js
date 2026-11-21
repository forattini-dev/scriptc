class Values {
  has(name) {
    if (arguments.length < 1) throw new Error('missing argument');
    return ['first', 'second'].findIndex((entry) => entry === name) !== -1;
  }
}

const values = new Values();
console.log(values.has('second'), values.has('missing'));
