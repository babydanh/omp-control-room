import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

// Import after mocking os.homedir so ownership locks stay inside the isolated home.
const { CompanyOwnership } = await import('../src/company/companyOwnership.js');

describe('CompanyOwnership', () => {
  let workspace: string;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-owner-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it('grants exactly one concurrent owner and lets the follower take over after release', async () => {
    const instances = [new CompanyOwnership(), new CompanyOwnership()];
    const outcomes = await Promise.all(instances.map((instance) => instance.acquire(workspace)));

    expect(outcomes.filter((outcome) => outcome === 'owner')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'follower')).toHaveLength(1);

    const ownerIndex = outcomes.indexOf('owner');
    const followerIndex = outcomes.indexOf('follower');
    await instances[followerIndex].release();
    expect(await new CompanyOwnership().acquire(workspace)).toBe('follower');
    await instances[ownerIndex].release();
    expect(await instances[followerIndex].acquire(workspace)).toBe('owner');
    await instances[followerIndex].release();
  });
});
