export class TurnQueue {
  private readonly pending = new Set<number>();

  private readonly order: number[] = [];

  private readonly requeue = new Set<number>();

  private running = false;

  private scheduled = false;

  private activeChatId: number | null = null;

  constructor(private readonly handler: (chatId: number) => Promise<boolean>) {}

  enqueue(chatId: number): void {
    if (this.activeChatId === chatId) {
      this.requeue.add(chatId);
      return;
    }

    if (this.pending.has(chatId)) {
      return;
    }

    this.pending.add(chatId);
    this.order.push(chatId);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        void this.drain();
      });
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.order.length > 0) {
        const chatId = this.order.shift();
        if (chatId === undefined) {
          continue;
        }

        this.pending.delete(chatId);
        this.activeChatId = chatId;
        const hasMore = await this.handler(chatId);
        this.activeChatId = null;

        if (hasMore || this.requeue.has(chatId)) {
          this.requeue.delete(chatId);
          this.enqueue(chatId);
        }
      }
    } finally {
      this.activeChatId = null;
      this.running = false;
    }
  }
}
