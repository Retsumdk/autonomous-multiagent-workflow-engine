export interface Clock {
  now(): number;
}

export function systemClock(): Clock {
  return { now: () => Date.now() };
}

export interface FixedClock extends Clock {
  advance(milliseconds: number): void;
  set(epochMs: number): void;
}

export function fixedClock(startEpochMs: number): FixedClock {
  let current = startEpochMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(epochMs: number) {
      current = epochMs;
    },
  };
}

export type IdFactory = (prefix: string) => string;

export function idFactory(): IdFactory {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}_${counter.toString(36).padStart(4, "0")}`;
  };
}
