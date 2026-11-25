// Single time source so tests can replace it.
export const clock = { now: (): number => Date.now() };
