class Reader {
  private entries: any[] = [];
  read<T>(entry: T): void { this.entries.indexOf(entry); }
}
new Reader().read(3);
