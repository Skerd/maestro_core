/**
 * Wall-clock ↔ real-time conversion and interval arithmetic for anything that is
 * booked against opening or working hours. Hours are stored as wall-clock rows
 * (`WeeklyHoursSlot`) in the owning location's IANA timezone; everything that is
 * compared or stored is a real instant, so DST shifts never move a booking.
 *
 * Intervals are half-open `[start, end)`: a booking that ends at 10:00 and one that
 * starts at 10:00 do not overlap.
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import type {WeeklyHoursSlot} from "armonia/src/modules/core/helpers/weeklyHours.schema-def";

dayjs.extend(utc);
dayjs.extend(timezone);

export type TimeInterval = {start: Date; end: Date};

const LOCAL_FORMAT = "YYYY-MM-DD HH:mm";
const END_OF_DAY = "24:00";

export function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", {timeZone});
        return true;
    } catch {
        return false;
    }
}

/**
 * The instant a wall-clock time names in `timeZone`. Returns null when that local
 * time does not exist (the hour skipped by a spring-forward change). A time that
 * occurs twice (fall-back) resolves to the earlier instant.
 */
export function localToUtc(date: string, time: string, timeZone: string): Date | null {
    const local = `${date} ${time}`;
    const instant = dayjs.tz(local, timeZone);
    return instant.isValid() && instant.tz(timeZone).format(LOCAL_FORMAT) === local ? instant.toDate() : null;
}

/** The local calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): string {
    return dayjs(instant).tz(timeZone).format("YYYY-MM-DD");
}

/** The local wall-clock time (`HH:mm`) of an instant in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string): string {
    return dayjs(instant).tz(timeZone).format("HH:mm");
}

/** The local date `days` calendar days after `date` (both `YYYY-MM-DD`; negative goes back). */
export function addLocalDays(date: string, days: number): string {
    return dayjs.utc(date).add(days, "day").format("YYYY-MM-DD");
}

function nextDate(date: string): string {
    return addLocalDays(date, 1);
}

/**
 * Like {@link localToUtc}, but a time inside a DST gap moves forward instead of
 * failing, so an hours row that starts in the skipped hour still opens.
 */
function wallClockToUtc(date: string, time: string, timeZone: string): Date {
    if (time === END_OF_DAY) {
        return dayjs.tz(`${nextDate(date)} 00:00`, timeZone).toDate();
    }
    return dayjs.tz(`${date} ${time}`, timeZone).toDate();
}

/** The real-time span of one local calendar day in `timeZone` (23 or 25 hours on DST change days). */
export function localDayInterval(date: string, timeZone: string): TimeInterval {
    return {start: wallClockToUtc(date, "00:00", timeZone), end: wallClockToUtc(nextDate(date), "00:00", timeZone)};
}

/** Sorts and joins intervals that overlap or touch. */
export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
    const sorted = intervals
        .filter((interval) => interval.end > interval.start)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged: TimeInterval[] = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last && interval.start <= last.end) {
            if (interval.end > last.end) last.end = interval.end;
        } else {
            merged.push({start: interval.start, end: interval.end});
        }
    }
    return merged;
}

/**
 * The real-time intervals that weekly wall-clock rows cover between `from` and
 * `to` in `timeZone`, clipped to that window and merged. Rows whose end is not
 * after their start are ignored.
 */
export function expandWeeklyHours(slots: WeeklyHoursSlot[], timeZone: string, from: Date, to: Date): TimeInterval[] {
    const intervals: TimeInterval[] = [];
    const lastDate = localDateOf(to, timeZone);
    for (let date = localDateOf(from, timeZone); date <= lastDate; date = nextDate(date)) {
        const dayOfWeek = dayjs.utc(date).day();
        for (const slot of slots) {
            if (slot.dayOfWeek !== dayOfWeek || slot.endTime <= slot.startTime) continue;
            const start = wallClockToUtc(date, slot.startTime, timeZone);
            const end = wallClockToUtc(date, slot.endTime, timeZone);
            intervals.push({
                start: start < from ? from : start,
                end: end > to ? to : end,
            });
        }
    }
    return mergeIntervals(intervals);
}

/** The parts of time covered by both interval lists. */
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
    const left = mergeIntervals(a);
    const right = mergeIntervals(b);
    const result: TimeInterval[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        const start = left[i].start > right[j].start ? left[i].start : right[j].start;
        const end = left[i].end < right[j].end ? left[i].end : right[j].end;
        if (end > start) result.push({start, end});
        if (left[i].end < right[j].end) i++;
        else j++;
    }
    return result;
}

/** `base` with every part covered by `remove` cut out. */
export function subtractIntervals(base: TimeInterval[], remove: TimeInterval[]): TimeInterval[] {
    const cuts = mergeIntervals(remove);
    const result: TimeInterval[] = [];
    for (const interval of mergeIntervals(base)) {
        let start = interval.start;
        for (const cut of cuts) {
            if (cut.end <= start || cut.start >= interval.end) continue;
            if (cut.start > start) result.push({start, end: cut.start});
            if (cut.end > start) start = cut.end;
        }
        if (interval.end > start) result.push({start, end: interval.end});
    }
    return result;
}

/** True when two half-open intervals share any moment. */
export function overlaps(a: TimeInterval, b: TimeInterval): boolean {
    return a.start < b.end && b.start < a.end;
}

/** True when `inner` lies entirely inside one of `intervals`. */
export function isCovered(inner: TimeInterval, intervals: TimeInterval[]): boolean {
    return mergeIntervals(intervals).some((interval) => interval.start <= inner.start && inner.end <= interval.end);
}
