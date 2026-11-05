import {CronTime} from "cron";
import {describe, expect, it} from "vitest";
import {isValidCronExpression} from "armonia/src/modules/core/helpers/cronExpression";

/** Forms validate with armonia's syntax check; the scheduler parses with `cron`. They must agree. */
function cronAccepts(expression: string): boolean {
    try {
        new CronTime(expression);
        return true;
    } catch {
        return false;
    }
}

const CORPUS = [
    "* * * * *", "*/5 * * * *", "0 */2 * * *", "0 0 * * 0", "0 0 * * 7", "0 0 1 * *", "0 30 2 * * mon-fri",
    "0 0 1 jan *", "0 0 * * SUN", "15,45 8-18/2 * * 1-5", "5/10 * * * *", "0 0 0 * * *", "@daily", "@weekdays",
    "@DAILY", "  0 0 * * *  ", "0 0 * jan-mar mon",
    "", "* * * *", "* * * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *",
    "* * * * 8", "5-1 * * * *", "*/0 * * * *", "1* * * * *", "1,,2 * * * *", "0 0 * * xyz", "@often", "a b c d e",
    "-1 * * * *", "1-2-3 * * * *", "0 0 * * mon/2", "*/ * * * *", "? * * * *", "0 0 L * *",
];

describe("isValidCronExpression matches the scheduler's CronTime", () => {
    it.each(CORPUS)("%j", (expression) => {
        expect(isValidCronExpression(expression)).toBe(cronAccepts(expression));
    });

    it("agrees on random field combinations", () => {
        const pieces = ["*", "*/5", "0", "7", "59", "60", "1-5", "5-1", "1,2", "1/0", "jan", "mon", "x", "2-31/3", ""];
        let seed = 7;
        const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
        for (let i = 0; i < 2000; i++) {
            const count = 4 + (next() % 4);
            const expression = Array.from({length: count}, () => pieces[next() % pieces.length]).join(" ");
            expect(isValidCronExpression(expression), expression).toBe(cronAccepts(expression));
        }
    });
});
