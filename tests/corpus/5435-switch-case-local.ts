function parse(field: string, value: string): number {
  let result = 0;
  switch (field) {
    case 'retry':
      const retry = parseInt(value, 10);
      if (!isNaN(retry)) result = retry;
      break;
    case 'length':
      const length = value.length;
      result = length;
      break;
    default:
      result = -1;
  }
  return result;
}

console.log(parse('retry', '25'), parse('length', 'abcd'), parse('missing', 'x'));
