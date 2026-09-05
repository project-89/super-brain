/** Guards asynchronous pages against a changed API identity, entity or revision. */
export class RequestScope {
  private key: readonly unknown[] = [];
  private generation = 0;
  select(key: readonly unknown[]): void { if (key.length !== this.key.length || key.some((value, index) => !Object.is(value, this.key[index]))) { this.key = key; this.generation += 1; } }
  capture(): number { return this.generation; }
  current(generation: number): boolean { return generation === this.generation; }
  invalidate(): void { this.generation += 1; }
}
