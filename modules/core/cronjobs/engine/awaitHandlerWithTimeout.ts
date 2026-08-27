/** Abort `controller` and reject if `handlerPromise` has not settled by `timeoutMs`. */
export function awaitHandlerWithTimeout(
    handlerPromise: Promise<void>,
    controller: AbortController,
    timeoutMs: number,
    timeoutMessage: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error(timeoutMessage));
        }, timeoutMs);
        handlerPromise.then(
            () => {
                clearTimeout(timer);
                resolve();
            },
            err => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}
