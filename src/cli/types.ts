export interface Command {
  /** `--help` や引数エラーのときに表示する使い方。 */
  usage: string;
  run(argv: string[]): void | Promise<void>;
}
