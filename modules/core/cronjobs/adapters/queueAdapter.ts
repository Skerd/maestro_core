export type CronQueueMessage = {
    jobId: string;
    executionId?: string;
    attempt: number;
    company?: string | null;
    handler: string;
    metadata?: Record<string, unknown>;
    enqueuedAt: string;
    notBefore?: string;
};

export interface QueueAdapter {
    enqueue(msg: CronQueueMessage): Promise<void>;
    startConsumer(onMessage: (msg: CronQueueMessage) => Promise<void>): Promise<void>;
    stopConsumer(): Promise<void>;
    getQueueDepth(): Promise<number>;
}
