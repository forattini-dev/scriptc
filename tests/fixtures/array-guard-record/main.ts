type Result = { status?: string[] };
function display(result: Result) {
  return result.status
    ? [{ key: 'Status', value: Array.isArray(result.status) ? result.status.join(', ') : result.status }]
    : [];
}
console.log(JSON.stringify(display({ status: ['one', 'two'] })));
