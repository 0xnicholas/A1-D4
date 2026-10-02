/**
 * The package's public face: `cron(expression, options?)` as a `schedules.save()` fragment
 * (`docs/architecture/harness.md`「croner 封装能力包」). Tests assert the fragment's shape, the
 * `next` semantics croner is relied on for, the closed option subset, and the build-time probe's
 * error surface. Occurrence assertions pin an explicit IANA timezone where the host's local
 * timezone would otherwise leak in (croner's default is the process timezone).
 */
import { describe, expect, it } from 'vitest';
import { cron, type CronFragment, type CronOptions } from '@balsats/croner';

describe('the save fragment', () => {
  it('returns { next }, and adds timezone only when one is given', () => {
    const bare: CronFragment = cron('0 9 * * *');
    expect(Object.keys(bare)).toEqual(['next']);

    const options: CronOptions = { timezone: 'Asia/Shanghai' };
    const zoned: CronFragment = cron('0 9 * * *', options);
    expect(Object.keys(zoned)).toEqual(['next', 'timezone']);
    expect(zoned.timezone).toBe('Asia/Shanghai');
  });

  it('next(from) is the first occurrence strictly after from', () => {
    const { next } = cron('0 9 * * *', { timezone: 'UTC' });

    expect(next(new Date('2026-01-01T08:59:59.999Z'))).toEqual(new Date('2026-01-01T09:00:00Z'));
    expect(next(new Date('2026-01-01T09:00:00.000Z'))).toEqual(new Date('2026-01-02T09:00:00Z'));
  });

  it('advances through a year of daily occurrences, one minute at a time of the clock', () => {
    const { next } = cron('0 9 * * *', { timezone: 'UTC' });
    let from = new Date('2026-01-01T00:00:00Z');
    let previous = from;

    for (let day = 0; day < 30; day += 1) {
      const occurrence = next(from);
      expect(occurrence).not.toBeNull();
      expect(occurrence!.getTime()).toBeGreaterThan(previous.getTime());
      expect(occurrence!.getUTCHours()).toBe(9);
      expect(occurrence!.getUTCMinutes()).toBe(0);
      previous = occurrence!;
      from = occurrence!;
    }
  });
});

describe('validation: everything at the cron() call site', () => {
  it("passes croner's structural and range errors through untouched", () => {
    expect(() => cron('not a cron')).toThrow(TypeError);
    expect(() => cron('not a cron')).toThrow(/exactly five, six, or seven space separated parts/);
    expect(() => cron('61 * * * *')).toThrow(RangeError);
    expect(() => cron('61 * * * *')).toThrow(/Invalid value for minute: 61/);
  });

  it('probes an invalid IANA timezone at construction, where croner defers it to nextRun', () => {
    expect(() => cron('0 9 * * *', { timezone: 'Planet/Nowhere' })).toThrow(TypeError);
    expect(() => cron('0 9 * * *', { timezone: 'Planet/Nowhere' })).toThrow(/Planet\/Nowhere/);
  });

  it('next is pure computation: repeated calls never throw', () => {
    const { next } = cron('0 9 * * *', { timezone: 'Asia/Shanghai' });
    expect(next(new Date('2026-01-01T00:00:00Z'))).toEqual(new Date('2026-01-01T01:00:00Z'));
    expect(next(new Date('2026-01-01T00:00:00Z'))).toEqual(new Date('2026-01-01T01:00:00Z'));
  });
});

describe('the expression surface', () => {
  it('reads the 6-part form as seconds-first', () => {
    const { next } = cron('*/10 * * * * *', { timezone: 'UTC' });

    expect(next(new Date('2026-01-01T00:00:00.000Z'))).toEqual(new Date('2026-01-01T00:00:10Z'));
    expect(next(new Date('2026-01-01T00:00:00.500Z'))).toEqual(new Date('2026-01-01T00:00:10Z'));
  });

  it('supports @-nicknames and month/weekday names', () => {
    expect(cron('@daily', { timezone: 'UTC' }).next(new Date('2026-01-01T12:00:00Z'))).toEqual(
      new Date('2026-01-02T00:00:00Z'),
    );
    expect(cron('0 9 * * MON', { timezone: 'UTC' }).next(new Date('2026-01-01T00:00:00Z'))).toEqual(
      new Date('2026-01-05T09:00:00Z'),
    );
  });

  it('returns null when no occurrence is left (7-part year in the past)', () => {
    const { next } = cron('0 0 0 1 1 * 2020', { timezone: 'UTC' });

    expect(next(new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it("passes croner's once mode through: a date-time string fires once, then is exhausted", () => {
    const { next } = cron('2030-01-01T00:00:00Z');

    expect(next(new Date('2026-01-01T00:00:00Z'))).toEqual(new Date('2030-01-01T00:00:00Z'));
    expect(next(new Date('2030-01-01T00:00:00Z'))).toBeNull();
  });

  it('reads the expression in the given IANA timezone', () => {
    const { next } = cron('0 9 * * *', { timezone: 'Asia/Shanghai' });

    expect(next(new Date('2026-01-01T00:00:00Z'))).toEqual(new Date('2026-01-01T01:00:00Z'));
  });

  it('passes DST behavior through as-is: gap days map by offset, overlap days run once', () => {
    // Facts pinned from docs/research/croner.md (Europe/Stockholm, 2026). On the spring-forward
    // day the 02:30 pattern lands on 03:30 CEST — the same instant the 03:30 pattern lands on
    // (upstream's README says "skipped"; the observed behavior wins). On the fall-back day only
    // the first 02:30 (CEST) runs. DST semantics are part of this package's product surface, so a
    // croner bump that changes either must show up as a failing test here.
    const gapDay = cron('30 2 * * *', { timezone: 'Europe/Stockholm' });
    expect(gapDay.next(new Date('2026-03-28T12:00:00Z'))).toEqual(new Date('2026-03-29T01:30:00Z'));
    expect(gapDay.next(new Date('2026-03-29T01:30:00Z'))).toEqual(new Date('2026-03-30T00:30:00Z'));

    const overlapDay = cron('30 2 * * *', { timezone: 'Europe/Stockholm' });
    expect(overlapDay.next(new Date('2026-10-24T12:00:00Z'))).toEqual(
      new Date('2026-10-25T00:30:00Z'),
    );
    expect(overlapDay.next(new Date('2026-10-25T00:30:00Z'))).toEqual(
      new Date('2026-10-26T01:30:00Z'),
    );
  });
});

describe('the option subset is closed', () => {
  it('exposes timezone only: other croner options are neither typed nor honored', () => {
    // @ts-expect-error `startAt` is outside the closed subset (clamping = destructure and wrap `next`).
    const fragment = cron('0 9 * * *', { timezone: 'UTC', startAt: new Date('2030-01-01T00:00:00Z') });

    expect(fragment.next(new Date('2026-01-01T00:00:00Z'))).toEqual(new Date('2026-01-01T09:00:00Z'));
  });
});
