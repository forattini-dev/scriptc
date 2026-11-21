function show(refs: { propertyPath?: string[] | null }) {
  console.log("path", refs.propertyPath?.toString());
}

show({ propertyPath: ["root", "child"] });
show({ propertyPath: [] });
show({ propertyPath: null });
show({});

function showMixed(refs: { propertyPath?: (string | null | undefined)[] }) {
  console.log("mixed", refs.propertyPath?.toString());
}

showMixed({ propertyPath: ["a", null, undefined, "b"] });
showMixed({});

