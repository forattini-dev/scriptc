function effect(label: string): number {
    console.log(label);
    return 1;
}

function main(): void {
    const unusedLiteral = 1;
    const unusedAlias = unusedLiteral;
    const unusedCall = effect("declaration");
    let unusedAssignment = effect("initializer");
    unusedAssignment = effect("assignment");
}

main();
