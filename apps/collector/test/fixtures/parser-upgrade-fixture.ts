interface UpgradedParser<Entry, Damage> {
  readonly parser: { snapshot(): object };
  read(entries: readonly Entry[], damagedLines?: readonly Damage[]): object;
}

/**
 * Lets `ParserGolden` check a checkpoint upgrade. Each batch goes to `read`, as when the cursor backfills usage
 * up to the old checkpoint. The saved state is the snapshot of the upgraded parser.
 */
export class UpgradeGoldenFormat<Entry, Damage> {
  constructor(private readonly start: () => UpgradedParser<Entry, Damage> | undefined) {}

  resume() {
    const upgrade = this.start();
    if (!upgrade) throw new Error("This parser format has no upgrade");
    return {
      decodeBatch: (entries: readonly Entry[], damagedLines?: readonly Damage[]) => upgrade.read(entries, damagedLines),
      snapshot: () => upgrade.parser.snapshot(),
    };
  }
}
