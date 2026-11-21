type Options = { readonly cwd: string };

function commandPath(name: string, options?: Options): string {
  return options === undefined ? name : `${options.cwd}/${name}`;
}

const locate: (name: string) => string = commandPath;
console.log(locate("scriptc"));
