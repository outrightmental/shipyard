import type { AvailableRepo, GitHubStatus, SubscribedRepo } from '../../shared/protocol.js';

/**
 * The Repositories page as it was last drawn, kept in the browser.
 *
 * What the app can see is read from GitHub a hundred repositories at a time,
 * which takes seconds, and until it was in the page had nothing to show but
 * the repositories already subscribed to. So the list is kept, with what the
 * page drew beside it — which are subscribed to, and to whom each is assigned
 * — and the next arrival is drawn from that at once, while the fleet and the
 * list are read again behind it.
 *
 * It is what was true the last time this browser looked, and is treated so:
 * nothing can be changed from it, and the reading that follows replaces it.
 * Signing out forgets it.
 */

export const KEPT_REPOSITORIES_KEY = 'shipyard.console.repositories';
/** Changed whenever what is kept changes shape, so an older browser's copy is not read as this one. */
const VERSION = 1;

/** As much of a fleet member as a row of the table names. */
export interface MemberName {
  id: string;
  name: string;
}

export interface KeptRepositories {
  github: GitHubStatus;
  repos: SubscribedRepo[];
  members: MemberName[];
  /** What the installation `github` names can see; null when that has never been read. */
  available: AvailableRepo[] | null;
  /** When `available` was read, in epoch millis. */
  readAt: number | null;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This browser's storage, or null where there is none to be had (a private window, a test). */
export function browserStorage(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** What was kept, or null when nothing was, or what is there is not this. */
export function readKeptRepositories(storage: Store | null): KeptRepositories | null {
  try {
    const kept = JSON.parse(storage?.getItem(KEPT_REPOSITORIES_KEY) ?? 'null') as (Partial<KeptRepositories> & { v?: number }) | null;
    if (!kept || kept.v !== VERSION) return null;
    if (typeof kept.github !== 'object' || kept.github === null || !Array.isArray(kept.repos) || !Array.isArray(kept.members)) return null;
    const available = Array.isArray(kept.available) ? kept.available : null;
    return {
      github: kept.github,
      repos: kept.repos,
      members: kept.members,
      available,
      readAt: available !== null && typeof kept.readAt === 'number' ? kept.readAt : null,
    };
  } catch {
    return null;
  }
}

/** Keep it. A browser with no room for it keeps nothing, rather than what it kept before. */
export function keepRepositories(storage: Store | null, kept: KeptRepositories): void {
  try {
    storage?.setItem(KEPT_REPOSITORIES_KEY, JSON.stringify({ v: VERSION, ...kept }));
  } catch {
    forgetKeptRepositories(storage);
  }
}

export function forgetKeptRepositories(storage: Store | null): void {
  try { storage?.removeItem(KEPT_REPOSITORIES_KEY); } catch { /* no storage */ }
}
