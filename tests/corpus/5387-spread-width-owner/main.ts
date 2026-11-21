type Narrow = { name: string };

function view(value: Narrow) {
  console.log(value.name, JSON.stringify(value));
}

const source = { seed: true };
const complete = { ...source, name: 'native', extra: 'kept' };
view(complete);
