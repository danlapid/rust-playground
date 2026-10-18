// What happens during a run, as it happens: /api/run streams these to the page, which
// shows each Worker at work and each cache lookup's outcome.

/** Where a lookup's answer came from: Workers Cache, R2 behind it, or nowhere (so it's made). */
export type Outcome = 'hit' | 'r2' | 'miss';

export type RunEvent =
  /** A stage of the run. compile and link may come from the cache (`cached`). */
  | { type: 'step'; step: 'resolve' | 'deps' | 'compile' | 'link' | 'run'; state: 'start' | 'end'; ok?: boolean; cached?: boolean }
  /** A lookup: of the resolution, all the dependencies, one crate, or the snippet's build. */
  | { type: 'cache'; what: 'resolve' | 'deps' | 'unit' | 'build'; id?: string; outcome: Outcome; ms: number }
  /** A crate, from when its dependencies are ready to when it's ready. */
  | { type: 'unit'; id: string; state: 'start' | 'end'; ok?: boolean; cached?: boolean; procMacro?: boolean; buildScript?: boolean }
  /** Work for a crate, by the Worker doing it. */
  | { type: 'work'; id: string; worker: WorkerName; what: string; state: 'start' | 'end'; ok?: boolean };

export type WorkerName = 'compiler' | 'dynamic' | 'crates.io';

export type Emit = (event: RunEvent) => void;

export const ignore: Emit = () => {};
