function report(value: any, array: any[]): void {
  console.log(value); console.log(array.length); console.log(Object.keys(array).join(',')); console.log(array[0]);
}
{ const a: number[] = []; report(a.shift()!, a); }
{ const a: number[] = [1,2]; report(a.shift()!, a); }
{ const a: number[] = []; a.length=2; a[1]=7; report(a.shift()!, a); }
{ const a: number[] = [1]; a.length=2; report(a.shift()!, a); }
{ const a: (number | undefined)[] = [undefined,7]; report(a.shift()!, a); }
{ const a: (number | undefined)[] = [7,undefined]; report(a.shift()!, a); }
{ const a: number[] = []; a[1_100_000]=7; report(a.shift()!, a); }
{ const a: number[] = [1]; a.length=3; a[2]=3; report(a.shift()!, a); }
