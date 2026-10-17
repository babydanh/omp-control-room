/**
 * CompanyOwnership: exactly one execution owner per canonical workspace.
 *
 * Both surfaces (VS Code extension and the standalone CLI) can be open on the
 * same workspace, and both would otherwise spawn runners and append to the
 * same journal. The lock is an exclusively-created descriptor file in the
 * workspace namespace, so the guarantee survives a crash: no in-memory mutex
 * and no lease to keep alive.
 *
 * `acquire()` returns `'owner'` to the single instance that created the
 * descriptor and `'follower'` to every other one. Only the owner schedules
 * work and writes state; followers read snapshots and proxy commands.
 *
 * Reconciliation rules, all fail-closed:
 *  - Descriptor names a live PID -> follower. A recycled PID therefore blocks
 *    ownership rather than double-launching runners; process-tree cleanup has
 *    its own start-time + nonce verification in the supervisor.
 *  - Descriptor names a dead PID -> reclaimed (the owner crashed).
 *  - Descriptor cannot be parsed -> follower until it is older than
 *    COMPANY_LOCK_TORN_DESCRIPTOR_MS, then reclaimed, so a crash between the
 *    exclusive create and its write cannot wedge the workspace forever.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CompanyError } from './companyError.js';
import { companyNamespaceDir, resolveWorkspaceKey } from './companyStore.js';
import {
  COMPANY_LOCK_DESCRIPTOR_RETRIES,
  COMPANY_LOCK_DESCRIPTOR_RETRY_MS,
  COMPANY_LOCK_TORN_DESCRIPTOR_MS,
  COMPANY_OWNER_DESCRIPTOR_FILE,
  COMPANY_OWNER_PROTOCOL_VERSION,
} from './constants.js';

export interface CompanyOwnerDescriptor {
  protocolVersion: number;
  /** PID of the owning process; used only for crash reconciliation. */
  pid: number;
  /** Wall-clock start of that process, distinguishing a recycled PID. */
  processStartTime: number;
  /** Random per-instance nonce; two locks never share one. */
  instanceNonce: string;
  /** Endpoint of the owner's local command broker (loopback only). */
  brokerEndpoint: string | null;
  acquiredAt: string;
}

export type CompanyOwnershipRole = 'owner' | 'follower';

/** Start of THIS process in ms since epoch. */
function ownProcessStartTime(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return delay(ms);
}

export class CompanyOwnership {
  private held = false;
  private descriptorPath: string | null = null;
  private descriptorNonce: string | null = null;

  /**
   * Acquire the owner role for a workspace. Pass a workspace path; the identity
   * key is derived from its realpath so path aliases share one namespace.
   */
  async acquire(workspaceKey: string): Promise<CompanyOwnershipRole> {
    if (this.held) {
      throw new CompanyError('ownership_conflict', 'This instance already holds ownership.');
    }
    const descriptorPath = path.join(
      companyNamespaceDir(await resolveWorkspaceKey(workspaceKey)),
      COMPANY_OWNER_DESCRIPTOR_FILE,
    );
    await fs.promises.mkdir(path.dirname(descriptorPath), { recursive: true });

    for (let attempt = 0; attempt < COMPANY_LOCK_DESCRIPTOR_RETRIES; attempt += 1) {
      if (await this.createDescriptor(descriptorPath)) {
        this.held = true;
        this.descriptorPath = descriptorPath;
        return 'owner';
      }
      const existing = await this.readDescriptor(descriptorPath);
      if (existing) {
        // A live PID -- including our own, when a sibling instance in this
        // process holds the lock -- means somebody else is scheduling.
        if (isProcessAlive(existing.pid)) return 'follower';
        await fs.promises.rm(descriptorPath, { force: true });
        continue;
      }
      // Unparsable descriptor: reclaim only once no writer could still be
      // mid-write, otherwise a slow write could produce two owners.
      if (await this.isStaleUnparsableDescriptor(descriptorPath)) {
        await fs.promises.rm(descriptorPath, { force: true });
        continue;
      }
      await sleep(COMPANY_LOCK_DESCRIPTOR_RETRY_MS);
    }
    return 'follower';
  }

  /** Release ownership. A follower release is a no-op. */
  async release(): Promise<void> {
    const descriptorPath = this.descriptorPath;
    const nonce = this.descriptorNonce;
    this.held = false;
    this.descriptorPath = null;
    this.descriptorNonce = null;
    if (!descriptorPath || !nonce) return;
    // Only remove OUR descriptor: if a successor already took the lock, its
    // nonce differs and deleting the file would hand ownership to two writers.
    const existing = await this.readDescriptor(descriptorPath);
    if (!existing || existing.instanceNonce !== nonce) return;
    await fs.promises.rm(descriptorPath, { force: true });
  }

  /** True while this instance holds the owner role. */
  get isOwner(): boolean {
    return this.held;
  }

  private async createDescriptor(descriptorPath: string): Promise<boolean> {
    const descriptor: CompanyOwnerDescriptor = {
      protocolVersion: COMPANY_OWNER_PROTOCOL_VERSION,
      pid: process.pid,
      processStartTime: ownProcessStartTime(),
      instanceNonce: randomUUID(),
      brokerEndpoint: null,
      acquiredAt: new Date().toISOString(),
    };
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(descriptorPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify(descriptor, null, 2), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.descriptorNonce = descriptor.instanceNonce;
    return true;
  }

  private async readDescriptor(descriptorPath: string): Promise<CompanyOwnerDescriptor | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(descriptorPath, 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CompanyOwnerDescriptor>;
      if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
      return {
        protocolVersion: parsed.protocolVersion ?? COMPANY_OWNER_PROTOCOL_VERSION,
        pid: parsed.pid,
        processStartTime: parsed.processStartTime ?? 0,
        instanceNonce: parsed.instanceNonce ?? '',
        brokerEndpoint: parsed.brokerEndpoint ?? null,
        acquiredAt: parsed.acquiredAt ?? '',
      };
    } catch {
      return null;
    }
  }

  private async isStaleUnparsableDescriptor(descriptorPath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(descriptorPath);
      return Date.now() - stats.mtimeMs > COMPANY_LOCK_TORN_DESCRIPTOR_MS;
    } catch {
      return false;
    }
  }
}
