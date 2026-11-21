function invoke(listener: (...args: any[]) => void) { listener('value'); }
invoke(function (value) { console.log(value, Array.isArray(arguments)); });
