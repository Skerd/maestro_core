export type CronQueueMessage = {
    jobId: string;
    executionId?: string;
    attempt: number;
    /** Times the queue consumer has already failed to process this message (absent = 0). */
    deliveryAttempt?: number;
    company?: string | null;
    handler: string;
    metadata?: Record<string, unknown>;
    enqueuedAt: string;
    notBefore?: string;
    manual?: boolean;
};

export interface QueueAdapter {
    enqueue(msg: CronQueueMessage): Promise<void>;
    startConsumer(onMessage: (msg: CronQueueMessage) => Promise<void>): Promise<void>;
    stopConsumer(): Promise<void>;
    getQueueDepth(): Promise<number>;
}
