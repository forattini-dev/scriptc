const order: string[] = [];

async function returned(): Promise<number> {
    return await Promise.resolve(3);
}

async function assigned(): Promise<number> {
    let value = 0;
    value = await Promise.resolve(4);
    return value;
}

async function conditional(): Promise<number> {
    if (await Promise.resolve(true)) {
        order.push("if");
    }
    switch (await Promise.resolve("yes")) {
        case "yes": order.push("switch"); break;
    }
    return 5;
}

async function thrown(): Promise<string> {
    try {
        throw await Promise.resolve(new Error("boom"));
    } catch (error) {
        return (error as Error).message;
    }
}

async function unitResult(): Promise<void> {
    order.push("unit-start");
    return await Promise.resolve();
}

async function projectedConsumers(flag: boolean): Promise<string> {
    const selected: number = flag ? await Promise.resolve(6) : 7;
    let assignedValue: number | undefined;
    assignedValue = flag ? await Promise.resolve(8) : undefined;
    const nested = flag ? "outer" : await Promise.resolve(true) ? "inner" : "wrong";
    if (flag ? await Promise.resolve(true) : false) {
        order.push("projected-if");
    }
    const exit = (await Promise.resolve(0)) === 0 ? "exit" : "wrong";
    return flag ? await Promise.resolve(`${selected}:${assignedValue}:${nested}:${exit}`) : "wrong";
}

async function switched(value: number): Promise<void> {
    switch (value) {
        case 1: {
            order.push(await Promise.resolve("switch-one"));
        }
        case 2:
            order.push(await Promise.resolve("switch-two"));
            break;
        default:
            order.push(await Promise.resolve("switch-default"));
    }
    order.push("switch-after");
}

async function infiniteMenu(choice: string): Promise<number> {
    let last = 0;
    for (;;) {
        switch (choice) {
            case "work":
                last = await Promise.resolve(1);
                break;
            default:
                return last;
        }
    }
}

async function main(): Promise<void> {
    const values = await Promise.all([returned(), assigned(), conditional(), thrown()]);
    await unitResult();
    const projected = await projectedConsumers(true);
    await switched(1);
    await switched(3);
    const menu = await infiniteMenu("quit");
    console.log(values.join(","), projected, menu, order.join(","));
}

void main();
