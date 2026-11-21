class Provider {
  async request(ok: boolean): Promise<string> {
    if (!ok) {
      await this.handleError(404);
    }
    return "body";
  }

  private async handleError(status: number): Promise<never> {
    let errorData: any = {};
    try {
      errorData = JSON.parse('{"error":{"message":"nope"}}');
    } catch {
      // ignore
    }
    const message = errorData.error?.message || "unknown";
    throw new Error(`${status}: ${message}`);
  }
}

const provider = new Provider();
provider.request(true).then((value) => console.log("ok", value));
provider.request(false).catch((error: unknown) => console.log("failed", (error as Error).message));
