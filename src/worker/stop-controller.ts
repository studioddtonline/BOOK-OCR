/** Ctrl+C等で待機中のsleepを即座に中断できるようにするための制御。 */
export class StopController {
  stopped = false;
  private wake?: () => void;

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
