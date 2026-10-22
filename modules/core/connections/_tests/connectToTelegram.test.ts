import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({
    bots: [] as any[],
    findOne: vi.fn(),
    holdsLock: true,
}));

vi.mock("telegraf", () => {
    class FakeTelegraf {
        handlers: Record<string, (ctx: any) => Promise<void>> = {};
        catchHandler?: (error: unknown, ctx: any) => void;
        private stopPolling?: () => void;
        launch = vi.fn((_options: object, onLaunch: () => void) => new Promise<void>((resolve) => {
            this.stopPolling = resolve;
            onLaunch();
        }));
        stop = vi.fn(() => {
            if (!this.stopPolling) throw new Error("Bot is not running!");
            this.stopPolling();
            this.stopPolling = undefined;
        });
        telegram = {sendMessage: vi.fn()};
        constructor() {
            state.bots.push(this);
        }
        start(handler: (ctx: any) => Promise<void>) { this.handlers.start = handler; }
        help(handler: (ctx: any) => Promise<void>) { this.handlers.help = handler; }
        command(name: string, handler: (ctx: any) => Promise<void>) { this.handlers[name] = handler; }
        catch(handler: (error: unknown, ctx: any) => void) { this.catchHandler = handler; }
    }
    return {Telegraf: FakeTelegraf};
});
vi.mock("@coreModule/database/schemas/user/user", () => ({
    default: {findOne: (query: object) => ({select: () => state.findOne(query)})},
}));
vi.mock("@coreModule/environment", () => ({
    TELEGRAM: {TOKEN: "token", NAME: "bot"},
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));
vi.mock("@coreModule/domain/notifications/notificationEventBus", () => ({
    emitNotificationEvent: vi.fn(),
    NotificationEventCodes: {TELEGRAM_LINKED: "TELEGRAM_LINKED"},
}));
vi.mock("@coreModule/connections/connectToRedis", () => ({
    redisTryAcquireOrRenewLock: vi.fn(async () => state.holdsLock),
    redisReleaseLock: vi.fn(async () => {}),
    redisGet: vi.fn(async () => null),
    redisSetEx: vi.fn(async () => {}),
    redisDel: vi.fn(async () => {}),
}));
vi.mock("@coreModule/utilities/timing/healthSnapshot", () => ({
    TELEGRAM_HEALTH_SNAPSHOT_KEY: "health:telegram",
    TELEGRAM_HEALTH_SNAPSHOT_TTL_SECONDS: 30,
}));
vi.mock("@coreModule/utilities/serviceMetrics/serviceCounters", () => ({
    telegramCounter: {hydrate: vi.fn(async () => {}), getStats: vi.fn(() => ({}))},
}));
vi.mock("@coreModule/utilities/uptime/uptimeKeeper", () => ({
    uptimeKeeper: {markStart: vi.fn(async () => {}), getLastStart: vi.fn(() => 0)},
}));

function fakeCtx(overrides: Record<string, unknown> = {}) {
    return {
        chat: {id: 42},
        payload: "code-123",
        from: {first_name: "Ann", last_name: undefined, is_bot: false},
        update: {update_id: 1},
        reply: vi.fn(async () => {}),
        ...overrides,
    };
}

function fakeUser() {
    return {
        _id: {toString: () => "user-1"},
        username: "ann@example.com",
        companies: ["company-1"],
        telegram: undefined as undefined | {chatId: number; runProtocols: boolean},
        set: vi.fn(),
        save: vi.fn(async () => {}),
    };
}

async function started() {
    const telegram = await import("../connectToTelegram");
    const {getLogger} = await import("@coreModule/loggers/serverLog");
    await telegram.connectToTelegramInstance(getLogger("telegram_test"));
    await vi.advanceTimersByTimeAsync(0);
    return {telegram, bot: state.bots[state.bots.length - 1]};
}

describe("connectToTelegram", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        state.bots.length = 0;
        state.findOne.mockReset();
        state.holdsLock = true;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("links the chat on /start and consumes the code", async () => {
        const {bot} = await started();
        const user = fakeUser();
        state.findOne.mockResolvedValue(user);
        const ctx = fakeCtx();

        await bot.handlers.start(ctx);

        expect(state.findOne).toHaveBeenCalledWith({"requests.telegram.code": "code-123"});
        expect(user.telegram?.chatId).toBe(42);
        expect(user.set).toHaveBeenCalledWith("requests.telegram.code", undefined);
        expect(user.save).toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith("Telegram successfully activated for your account: ann@example.com");
    });

    it("explains how to link when /start has no code, without a lookup", async () => {
        const {bot} = await started();
        const ctx = fakeCtx({payload: ""});

        await bot.handlers.start(ctx);

        expect(state.findOne).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("scan the Telegram QR code"));
    });

    it("rejects an unknown or already used code", async () => {
        const {bot} = await started();
        state.findOne.mockResolvedValue(null);
        const ctx = fakeCtx();

        await bot.handlers.start(ctx);

        expect(ctx.reply).toHaveBeenCalledWith("Invalid verification code. Please generate a new QR code.");
    });

    it("does not count a database failure against the Telegram circuit breaker", async () => {
        const {bot} = await started();
        const {telegramCircuitBreaker} = await import("@coreModule/utilities/circuitBreaker");
        state.findOne.mockRejectedValue(new Error("mongo down"));
        const ctx = fakeCtx();

        await bot.handlers.start(ctx);

        expect(ctx.reply).toHaveBeenCalledWith("An error occurred while linking your account. Please try again.");
        expect(telegramCircuitBreaker.getStats().totalFailures).toBe(0);
    });

    it("greets with only the names the user has", async () => {
        const {bot} = await started();
        const ctx = fakeCtx();

        await bot.handlers.hi(ctx);

        expect(ctx.reply).toHaveBeenCalledWith("Hey there Ann!");
    });

    it("registers a catch-all error handler so polling survives handler errors", async () => {
        const {bot} = await started();

        expect(bot.catchHandler).toBeTypeOf("function");
    });

    it("polls only while it holds the leadership lock", async () => {
        const {telegram, bot} = await started();
        expect(bot.launch).toHaveBeenCalledTimes(1);
        expect(telegram.getTelegramBot()).toBe(bot);

        state.holdsLock = false;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(bot.stop).toHaveBeenCalledTimes(1);
    });

    it("stays a follower when another instance holds the lock", async () => {
        state.holdsLock = false;
        const {bot} = await started();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(bot.launch).not.toHaveBeenCalled();
    });

    it("stops polling and releases the lock on disconnect", async () => {
        const {telegram, bot} = await started();
        const {redisReleaseLock} = await import("@coreModule/connections/connectToRedis");

        await telegram.disconnectFromTelegram();

        expect(bot.stop).toHaveBeenCalledTimes(1);
        expect(redisReleaseLock).toHaveBeenCalledWith("telegram:poller:leader", expect.any(String));
    });
});
