function invoke(listener: (...args: any[]) => void) { listener('inner'); }
function outer(marker: string) {
  invoke((value) => { console.log(arguments[0], marker, value === 'inner'); });
}
outer('outer');
