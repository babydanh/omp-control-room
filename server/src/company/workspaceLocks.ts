/**
 * workspaceLocks: exclusive ownership of what a task may write.
 *
 * Two tasks that write the same bytes corrupt each other's work, so the
 * scheduler never dispatches a task whose declared write scopes overlap a
 * running one. This registry is the authority for that question, and it is
 * deliberately pessimistic:
 *
 *  - Identity is the CANONICAL path, not the declared spelling. `src/../src/a.ts`,
 *    `SRC/A.ts` on Windows, and a path through a symlink all resolve to one key,
 *    because the canonicalizer resolves the nearest existing ancestor with
 *    `realpath` before the key is folded.
 *  - A directory scope contains everything under it, so `src` conflicts with
 *    `src/a.ts` in both directions. Two different FILES never conflict.
 *  - A scope that cannot be canonicalized — it escapes the workspace, follows a
 *    symlink out of it, or names something the resolver cannot place — locks the
 *    WHOLE workspace. "I could not tell what this touches" must not become "I
 *    may touch anything in parallel".
 *  - Shared resources (`package.json`, a lockfile, a schema) serialize whoever
 *    declares them, because those files are rewritten by tools no scope list can
 *    enumerate.
 *
 * Acquisition is ALL-OR-NOTHING per owner. A request either takes every scope
 * and every resource it names, or takes nothing and reports exactly who holds
 * what. A partially locked task that then failed to start would wedge the scopes
 * it did get against a runner that never existed.
 */

import * as path from 'node:path';

import type { WriteScope } from '../../../core/src/company.js';
import { resolveWorkspaceTarget } from './permissionPolicy.js';

/** Canonicalize a workspace-relative path, or return null when it cannot be placed. */
export type ScopeCanonicalizer = (workspaceRoot: string, relativePath: string) => string | null;

export type LockScopeKind = 'file' | 'directory';

export interface LockScope {
  /** Canonical, separator-normalized identity used for comparison. */
  readonly key: string;
  readonly kind: LockScopeKind;
  /** The workspace-relative path the Contract declared, for messages. */
  readonly declaredPath: string;
  /**
   * True when the scope did not resolve and therefore locks the whole
   * workspace. Reported rather than hidden, so the user can see why one task
   * serialized against everything else.
   */
  readonly workspaceWide: boolean;
}

export interface LockRequest {
  /** The task (or session) that will own the lock. */
  readonly ownerId: string;
  readonly scopes: readonly WriteScope[];
  /** Logical names such as `package-lock.json`; serialized across owners. */
  readonly resources?: readonly string[];
}

export interface LockConflict {
  readonly kind: 'scope' | 'resource';
  readonly key: string;
  readonly declaredPath: string;
  readonly ownerIds: readonly string[];
}

export type LockResult =
  | {
      readonly granted: true;
      readonly scopes: readonly LockScope[];
      readonly resources: readonly string[];
    }
  | { readonly granted: false; readonly conflicts: readonly LockConflict[] };

export interface WorkspaceLockOptions {
  readonly workspaceRoot: string;
  /**
   * Case-insensitive path identity. Defaults to the host platform; tests pin it
   * so the Windows rule is exercised identically on every runner.
   */
  readonly caseInsensitive?: boolean;
  /** Test seam; production uses the realpath-based resolver. */
  readonly canonicalize?: ScopeCanonicalizer;
}

interface HeldKey {
  ownerId: string;
  /** Repeat acquisitions by the same owner; `release` clears them together. */
  count: number;
}

interface HeldScope {
  owners: Set<string>;
  kind: LockScopeKind;
}

export class WorkspaceLockTable {
  private readonly workspaceRoot: string;
  private readonly caseInsensitive: boolean;
  private readonly canonicalize: ScopeCanonicalizer;
  private readonly held = new Map<string, HeldKey>();
  private readonly heldScopes = new Map<string, HeldScope>();

  constructor(options: WorkspaceLockOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
    this.canonicalize = options.canonicalize ?? resolveWorkspaceTarget;
  }

  /** Canonical key of the workspace root, for reports and workspace-wide locks. */
  get workspaceKey(): string {
    return this.fold(this.workspaceRoot);
  }

  private fold(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    return this.caseInsensitive ? normalized.toLowerCase() : normalized;
  }

  /**
   * Key one declared scope, or the whole workspace when the path escapes, does
   * not exist under a placeable ancestor, or names the root itself.
   */
  resolveScope(scope: WriteScope): LockScope {
    const canonical = this.canonicalize(this.workspaceRoot, scope.path);
    if (canonical === null) {
      return {
        key: this.workspaceKey,
        kind: 'directory',
        declaredPath: scope.path,
        workspaceWide: true,
      };
    }
    return {
      key: this.fold(canonical),
      kind: scope.kind,
      declaredPath: scope.path,
      workspaceWide: false,
    };
  }

  /** Fold a shared-resource name through the same identity rules as a path. */
  resourceKey(resource: string): string {
    return this.fold(resource);
  }

  /**
   * Take every scope and resource in the request, or nothing.
   *
   * Re-acquiring a key this owner already holds succeeds and counts, so a task
   * that re-locks its own scope does not conflict with itself; `release` drops
   * the whole owner in one call regardless of the count.
   */
  acquire(request: LockRequest): LockResult {
    const scopes: LockScope[] = [];
    const seenScopes = new Set<string>();
    for (const scope of request.scopes) {
      const resolved = this.resolveScope(scope);
      if (seenScopes.has(resolved.key)) continue;
      seenScopes.add(resolved.key);
      scopes.push(resolved);
    }

    const resources: string[] = [];
    const seenResources = new Set<string>();
    for (const resource of request.resources ?? []) {
      const key = this.resourceKey(resource);
      if (seenResources.has(key)) continue;
      seenResources.add(key);
      resources.push(key);
    }

    const conflicts: LockConflict[] = [];
    for (const scope of scopes) {
      const owners = this.overlappingOwners(scope, request.ownerId);
      if (owners.length > 0) {
        conflicts.push({
          kind: 'scope',
          key: scope.key,
          declaredPath: scope.declaredPath,
          ownerIds: owners,
        });
      }
    }
    for (const resource of resources) {
      const holder = this.held.get(resource);
      if (holder && holder.ownerId !== request.ownerId) {
        conflicts.push({
          kind: 'resource',
          key: resource,
          declaredPath: resource,
          ownerIds: [holder.ownerId],
        });
      }
    }

    if (conflicts.length > 0) {
      return { granted: false, conflicts };
    }

    for (const scope of scopes) {
      const existing = this.held.get(scope.key);
      if (existing && existing.ownerId === request.ownerId) {
        existing.count += 1;
      } else {
        this.held.set(scope.key, { ownerId: request.ownerId, count: 1 });
      }
      const entry = this.heldScopes.get(scope.key) ?? {
        owners: new Set<string>(),
        kind: scope.kind,
      };
      entry.owners.add(request.ownerId);
      this.heldScopes.set(scope.key, entry);
    }
    for (const resource of resources) {
      const existing = this.held.get(resource);
      if (existing && existing.ownerId === request.ownerId) {
        existing.count += 1;
      } else {
        this.held.set(resource, { ownerId: request.ownerId, count: 1 });
      }
    }
    return { granted: true, scopes, resources };
  }

  /** Release every key an owner holds, whatever the acquisition count. */
  release(ownerId: string): void {
    for (const [key, entry] of [...this.held]) {
      if (entry.ownerId === ownerId) this.held.delete(key);
    }
    for (const [key, entry] of [...this.heldScopes]) {
      if (!entry.owners.delete(ownerId)) continue;
      if (entry.owners.size === 0) this.heldScopes.delete(key);
    }
  }

  /**
   * Owners holding a DIFFERENT lock that overlaps this scope.
   *
   * A directory — including one that resolved to the workspace — contains every
   * path beneath it, so containment counts in both directions as soon as either
   * side is a directory. Two file scopes overlap only when they are the same
   * file; `src/a.ts` and `src/a.ts.bak` must stay independent.
   */
  private overlappingOwners(scope: LockScope, requesterId: string): string[] {
    const owners = new Set<string>();
    for (const [key, entry] of this.heldScopes) {
      const same = key === scope.key;
      const nested =
        scope.kind === 'directory' || entry.kind === 'directory'
          ? key.startsWith(`${scope.key}/`) || scope.key.startsWith(`${key}/`)
          : false;
      if (!same && !nested) continue;
      for (const owner of entry.owners) {
        if (owner !== requesterId) owners.add(owner);
      }
    }
    return [...owners];
  }
}
