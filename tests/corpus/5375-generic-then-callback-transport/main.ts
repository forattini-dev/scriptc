class FluentPromise {
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve().then(onfulfilled, onrejected)
  }

}

new FluentPromise().then(() => 'generic-ok').then(value => console.log(value))
