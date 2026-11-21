const order: string[] = [];

function warning(): string {
  order.push('warning');
  return 'experimental feature';
}

function warningType(): string {
  order.push('type');
  return 'ExperimentalWarning';
}

process.emitWarning(warning(), warningType());
console.log(order.join(','));
