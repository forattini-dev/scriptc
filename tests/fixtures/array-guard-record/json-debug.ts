type Result = { status?: string[] };
function display(result: Result) {
  return result.status ? JSON.stringify(Array.isArray(result.status) ? result.status.join(', ') : result.status) : 'none';
}
try {
  console.log(display(JSON.parse('{"status":["x",1,null,false,{"a":1}]}') as Result));
} catch (error) {
  console.log('caught', error instanceof TypeError, (error as any).message);
}
