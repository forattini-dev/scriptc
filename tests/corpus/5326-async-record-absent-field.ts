interface Result {
    before: string;
    optional?: string;
    after: string;
}

const order: string[] = [];

function observe(value: string): string {
    order.push(value);
    return value;
}

async function result(): Promise<Result> {
    return {
        before: observe("before"),
        after: await Promise.resolve(observe("after")),
    };
}

result().then(value => {
    console.log(value.before, value.optional, value.after, order.join(","));
});
