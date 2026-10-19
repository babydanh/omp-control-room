import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';
import { pathsMatch, toPathKey } from './pathKey.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
  /** Permission posture for every launch on this host (the CLI's skip-permissions flag). */
  bypassPermissions: boolean;
  /** Whether the host's own Directories (VS Code's workspace folders, standalone's
   *  start directory) are listed in the launch drawer. Off by default. */
  showHostDirectories: boolean;
}

/** All keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`.
 *  The hooks preference is NOT here: it is per-provider and machine-global
 *  (the hooks it governs live in one home-directory file per provider), so it
 *  lives beside `hooksConsent` at the config top level, not per namespace. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'watchAllSessions',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
  'bypassPermissions',
  'showHostDirectories',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

/** What the user answered a provider's consent ask with, durably. `granted` is recorded BEFORE the install writes, so
 *  it can exist with nothing on disk; `declined` means the ANSWER itself turned hooks off, the provenance a revised
 *  "Not Now" needs to know the preference is its to take back (a Settings toggle never records consent). Absent =
 *  unanswered, the ask is still open. */
export type HooksConsentState = 'granted' | 'declined';
/**
 * A user-defined Directory as persisted. Only what the user chose is stored:
 * `source` is always `user` for these (see directories.ts).
 */
export interface UserDirectory {
  name: string;
  path: string;
}

/** Most recent Company workspace folders kept in config.json; the board lists them after the open ones. */
export const RECENT_COMPANY_WORKSPACES_LIMIT = 10;

/** Most display names kept for Company folders in config.json; the newest survive. */
export const COMPANY_FOLDER_NAMES_LIMIT = 500;

/** Longest display name kept for a Company folder, in characters. */
export const COMPANY_FOLDER_NAME_MAX_LENGTH = 80;

export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  /** Per-provider consent to modify that provider's settings file (Claude:
   *  ~/.claude/settings.json). Shared across surfaces — consent is per-human
   *  per-provider, not per-adapter. A provider absent from the map has never
   *  been answered. */
  hooksConsent: Record<string, HooksConsentState>;
  /** Per-provider hooks preference, machine-global for the same reason as the
   *  consent above. A provider absent from the map takes the default (true). */
  hooksEnabled: Record<string, boolean>;
  /** Company workspace folders the user opened, most recent first, capped at
   *  RECENT_COMPANY_WORKSPACES_LIMIT. Machine-wide like the consent above: a
   *  folder is a fact about this machine, not a per-adapter setting. */
  recentCompanyWorkspaces: string[];
  /** Display names for Company folders, keyed by the folder's path key. Machine-wide: a name belongs to the folder
   *  on this machine. Capped at COMPANY_FOLDER_NAMES_LIMIT, newest kept. */
  companyFolderNames: Record<string, string>;
  /** User-defined Directories. Machine-wide by decision: a Directory defined
   *  from the phone shows up in VS Code and vice versa. */
  directories: UserDirectory[];
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
  bypassPermissions: false,
  showHostDirectories: false,
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Coerce a loose object into the per-provider consent map, dropping entries whose value is not exactly 'granted' or
 *  'declined'. */
function parseHooksConsent(raw: unknown): Record<string, HooksConsentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HooksConsentState> = {};
  for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
    if (state === 'granted' || state === 'declined') out[providerId] = state;
  }
  return out;
}

/** Coerce a loose object into the per-provider hooks-preference map, dropping non-boolean values. */
function parseHooksEnabled(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') out[providerId] = enabled;
  }
  return out;
}

/**
 * Coerce a loose value into the recent-folder list: strings only, blanks and
 * spelling duplicates dropped, newest first, capped at the limit.
 */
function parseRecentCompanyWorkspaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    if (out.some((kept) => pathsMatch(kept, entry))) continue;
    out.push(entry);
    if (out.length === RECENT_COMPANY_WORKSPACES_LIMIT) break;
  }
  return out;
}

/** Trim a display name and cap it at COMPANY_FOLDER_NAME_MAX_LENGTH characters; null when nothing is left. */
function normaliseCompanyFolderName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const capped = Array.from(trimmed).slice(0, COMPANY_FOLDER_NAME_MAX_LENGTH).join('').trim();
  return capped.length > 0 ? capped : null;
}

/**
 * Coerce a loose object into the Company folder display-name map: string values only, absolute keys only, each key
 * folded with toPathKey, each name normalised. The newest COMPANY_FOLDER_NAMES_LIMIT entries survive.
 */
function parseCompanyFolderNames(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const byKey = new Map<string, string>();
  const entries: [string, unknown][] = Object.entries(raw);
  for (const [workspacePath, value] of entries) {
    if (typeof value !== 'string' || !path.isAbsolute(workspacePath)) continue;
    const name = normaliseCompanyFolderName(value);
    if (name === null) continue;
    const key = toPathKey(workspacePath);
    byKey.delete(key);
    byKey.set(key, name);
  }
  return Object.fromEntries([...byKey].slice(-COMPANY_FOLDER_NAMES_LIMIT));
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries
 * whose value is not an array of strings. Returns `{}` if the input isn't an
 * object. Used to defensively load Directory→area mappings from config.json,
 * which may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [directory, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof directory !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[directory] = filtered;
  }
  return out;
}

/**
 * Coerce a loose value into `UserDirectory[]`, dropping anything that isn't an
 * object with a string name and a string path. Same defensive posture as
 * parseAreaMappings: config.json is hand-editable and may predate this field.
 */
export function parseUserDirectories(raw: unknown): UserDirectory[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: UserDirectory[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { name, path: dirPath } = entry as { name?: unknown; path?: unknown };
    if (typeof name !== 'string' || typeof dirPath !== 'string' || dirPath.length === 0) {
      continue;
    }
    out.push({ name, path: dirPath });
  }
  return out;
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
    bypassPermissions:
      typeof obj.bypassPermissions === 'boolean'
        ? obj.bypassPermissions
        : DEFAULT_ADAPTER_SETTINGS.bypassPermissions,
    showHostDirectories:
      typeof obj.showHostDirectories === 'boolean'
        ? obj.showHostDirectories
        : DEFAULT_ADAPTER_SETTINGS.showHostDirectories,
  };
}

function emptyConfig(): PixelAgentsConfig {
  return {
    vscode: { ...DEFAULT_ADAPTER_SETTINGS },
    standalone: { ...DEFAULT_ADAPTER_SETTINGS },
    externalAssetDirectories: [],
    hooksConsent: {},
    hooksEnabled: {},
    recentCompanyWorkspaces: [],
    companyFolderNames: {},
    directories: [],
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return emptyConfig();
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      hooksConsent: parseHooksConsent(parsed.hooksConsent),
      hooksEnabled: parseHooksEnabled(parsed.hooksEnabled),
      recentCompanyWorkspaces: parseRecentCompanyWorkspaces(parsed.recentCompanyWorkspaces),
      companyFolderNames: parseCompanyFolderNames(parsed.companyFolderNames),
      directories: parseUserDirectories(parsed.directories),
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return emptyConfig();
  }
}

// ── Per-provider hooks consent + preference ─────────────────
// The provider id keys these maps (HookProvider.id — 'claude' today). All
// writers go through readConfig→writeConfig, so a hand-edited or older file
// degrades to "unanswered"/default rather than crashing.

/** What the user durably answered this provider's ask with, or 'unanswered'. */
export function getHooksConsent(providerId: string): HooksConsentState | 'unanswered' {
  return readConfig().hooksConsent[providerId] ?? 'unanswered';
}

/** Persist the one-time approval for modifying this provider's settings file. A grant REPLACING a decline also
 *  deletes that decline's hooks-off remnant in the same write: without it, an install that then FAILS leaves a grant
 *  beside the retracted hooks-off, and a later "Not Now" (which leaves the preference alone, since the grant never
 *  wrote it) ends at unanswered + hooks-off — an ask that never returns. A successful install persists hooks-on
 *  anyway, so this only changes the failure path. */
export function grantHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'granted') {
    const replacingDecline = cfg.hooksConsent[providerId] === 'declined';
    cfg.hooksConsent[providerId] = 'granted';
    if (replacingDecline) delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Record a durable decline ("Don't Ask Again"): consent 'declined' AND hooks-off, in ONE readConfig→writeConfig
 *  cycle. They are one logical answer — split across two writes, a failed second leaves a state the answer disavows
 *  (a decline with the default-on preference, or a hooks-off with no provenance). */
export function recordHooksDecline(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'declined' || cfg.hooksEnabled[providerId] !== false) {
    cfg.hooksConsent[providerId] = 'declined';
    cfg.hooksEnabled[providerId] = false;
    writeConfig(cfg);
  }
}

/** Un-record an answer AND restore the preference default in ONE cycle — the revised-notNow revert over a decline.
 *  Both keys go together so "never answered" and "answered and reverted" are indistinguishable on disk, and no
 *  partial-write order can leave a half-reverted answer. */
export function clearHooksAnswer(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent || providerId in cfg.hooksEnabled) {
    delete cfg.hooksConsent[providerId];
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Un-record an answer entirely, so the ask genuinely returns. Used when the
 *  user walks the Intro back from its closing step and revises an earlier
 *  answer down to "Not Now": whatever that answer left (a grant, a decline)
 *  must go, or the consent gate reads it as asked-and-answered forever.
 *  Callers only clear a grant after any uninstall verifiably landed. */
export function clearHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent) {
    delete cfg.hooksConsent[providerId];
    writeConfig(cfg);
  }
}

/** The per-provider hooks preference. Absent = the default, true. */
export function getHooksEnabled(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] ?? true;
}

export function setHooksEnabled(providerId: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.hooksEnabled[providerId] !== enabled) {
    cfg.hooksEnabled[providerId] = enabled;
    writeConfig(cfg);
  }
}

/** Restore the provider's preference to its default (true) by REMOVING the key. Deleting rather than writing `true`
 *  keeps "never answered" and "answered and reverted" indistinguishable on disk. */
export function clearHooksEnabled(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksEnabled) {
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Called on extension uninstall: return every hooks-related choice to factory state — all providers' consent and
 *  preferences cleared, hooksInfoShown back to default in both namespaces. Those choices belonged to an installation
 *  that no longer exists, so a future install starts from the first-run experience rather than inheriting a stale
 *  hooks-off that would skip the ask forever. */
export function resetHooksConfig(): void {
  const cfg = readConfig();
  cfg.hooksConsent = {};
  cfg.hooksEnabled = {};
  for (const ns of ['vscode', 'standalone'] as const) {
    cfg[ns].hooksInfoShown = DEFAULT_ADAPTER_SETTINGS.hooksInfoShown;
  }
  writeConfig(cfg);
}

/**
 * Atomically write the shared config. Never throws (most callers are
 * fire-and-forget settings writes that degrade to a console error); returns
 * whether the write landed, for callers whose success is reported to the user
 * — a Directory save must not be announced as saved when it never hit the disk.
 */
export function writeConfig(config: PixelAgentsConfig): boolean {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
    return false;
  }
}

/** Company workspace folders most recently opened, newest first. Empty when none were. */
export function readRecentCompanyWorkspaces(): string[] {
  return readConfig().recentCompanyWorkspaces;
}

/** Display names for Company folders, keyed by path key. Empty when none were set. */
export function readCompanyFolderNames(): Record<string, string> {
  return readConfig().companyFolderNames;
}

/**
 * The display name of the folder at this path, or undefined when it has none. The path is folded to its key first,
 * so any spelling of the same folder finds the same name.
 */
export function companyFolderNameFor(
  names: Readonly<Record<string, string>>,
  workspacePath: string,
): string | undefined {
  const key = toPathKey(workspacePath);
  return Object.hasOwn(names, key) ? names[key] : undefined;
}

/**
 * Give a Company folder a display name, or clear it with `null` or a blank name. The folder is keyed by its canonical
 * path. Returns whether the write reached the disk, so a failed save is never reported as a success.
 */
export function setCompanyFolderName(canonicalPath: string, name: string | null): boolean {
  const cfg = readConfig();
  const key = toPathKey(canonicalPath);
  const next = new Map(Object.entries(cfg.companyFolderNames));
  next.delete(key);
  const normalised = name === null ? null : normaliseCompanyFolderName(name);
  if (normalised !== null) next.set(key, normalised);
  cfg.companyFolderNames = Object.fromEntries([...next].slice(-COMPANY_FOLDER_NAMES_LIMIT));
  return writeConfig(cfg);
}

/**
 * Move one folder to the front of the recent list, dropping its older entry and
 * anything past the limit. Writes only when the order actually changes.
 */
export function rememberRecentCompanyWorkspace(workspacePath: string): void {
  const cfg = readConfig();
  const next = [
    workspacePath,
    ...cfg.recentCompanyWorkspaces.filter((entry) => !pathsMatch(entry, workspacePath)),
  ].slice(0, RECENT_COMPANY_WORKSPACES_LIMIT);
  const unchanged =
    next.length === cfg.recentCompanyWorkspaces.length &&
    next.every((entry, index) => entry === cfg.recentCompanyWorkspaces[index]);
  if (unchanged) return;
  cfg.recentCompanyWorkspaces = next;
  writeConfig(cfg);
}

/**
 * Drop one folder from the recent list, so it no longer shows. Returns whether the change reached the disk; a folder
 * that was not listed is already gone and counts as done. Its display name is kept.
 */
export function forgetRecentCompanyWorkspace(workspacePath: string): boolean {
  const cfg = readConfig();
  const next = cfg.recentCompanyWorkspaces.filter((entry) => !pathsMatch(entry, workspacePath));
  if (next.length === cfg.recentCompanyWorkspaces.length) return true;
  cfg.recentCompanyWorkspaces = next;
  return writeConfig(cfg);
}
