export const COMPANY_SCHEMA_VERSION = 1;
/** Approved Company workspace; independent of the Pixel Agents source checkout. */
export const COMPANY_DEFAULT_WORKSPACE_PATH = 'D:\\Duancanhan\\Project_QuanLyGiaiDau';
export const COMPANY_OMP_BRIDGE_FILENAME = 'company-omp-bridge.mjs';
export const COMPANY_PTY_HOST_FILENAME = 'company-pty-host.js';
export const COMPANY_MAX_RETAINED_SESSIONS = 10;
export const COMPANY_MAX_LIVE_RUNNERS = 4;
export const COMPANY_MAX_MODEL_CALLS = 4;
export const COMPANY_MAX_WORKERS = 4;
export const COMPANY_IDLE_PARK_SECONDS = 120;
export const COMPANY_MAX_PROMPT_BYTES = 2 * 1024 * 1024;
export const COMPANY_PROMPT_TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';
export const COMPANY_ARTIFACT_PAGE_BYTES = 64 * 1024;
export const COMPANY_ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const COMPANY_LOCK_DESCRIPTOR_RETRIES = 20;
export const COMPANY_LOCK_DESCRIPTOR_RETRY_MS = 25;
export const COMPANY_OWNER_PROTOCOL_VERSION = 1;

/** A lock file older than this with unreadable content is treated as crashed. */
export const COMPANY_LOCK_TORN_DESCRIPTOR_MS = 5_000;

// ── Workspace file browser ───────────────────────────────────
export const COMPANY_FILE_DEFAULT_PAGE_BYTES = 64 * 1024;
export const COMPANY_FILE_MAX_PAGE_BYTES = 256 * 1024;
/** Bytes sniffed for a NUL to decide text vs binary. */
export const COMPANY_FILE_BINARY_SNIFF_BYTES = 8000;
/** Directories the browser never lists: build output and VCS metadata. */
export const COMPANY_FILE_IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode-test',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
/** Extension -> media type. Anything absent is served as octet-stream. */
export const COMPANY_FILE_TEXT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.toml': 'application/toml',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

// ── Terminal + attachments ───────────────────────────────────
/** One input chunk; larger payloads are rejected rather than split. */
export const COMPANY_TERMINAL_INPUT_MAX_BYTES = 8 * 1024;
export const COMPANY_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;
export const COMPANY_DEFAULT_TERMINAL_COLS = 120;
export const COMPANY_DEFAULT_TERMINAL_ROWS = 32;

/** TERM value handed to every managed PTY. */
export const COMPANY_TERMINAL_NAME = 'xterm-256color';
// ── Durable namespace layout (~/.pixel-agents/company/<sha256(workspace)>/) ──
/** Parent directory for every workspace-scoped company namespace. */
export const COMPANY_STATE_DIR = 'company';
export const COMPANY_STATE_FILE = 'state.json';
export const COMPANY_JOURNAL_FILE = 'events.jsonl';
export const COMPANY_ARTIFACT_DIR = 'artifacts';
export const COMPANY_ARTIFACT_BODY_SUFFIX = '.bin';
export const COMPANY_ARTIFACT_META_SUFFIX = '.meta.json';
/** Owner descriptor written by CompanyOwnership; the lock IS this file. */
export const COMPANY_OWNER_DESCRIPTOR_FILE = 'owner.json';

/**
 * Company follows the host's OMP model roles instead of choosing its own, and
 * `hostModelRoles.ts` reads them live (`omp config get modelRoles --json`):
 * Director <- `plan`, Advisor <- `advisor`, Worker <- `task`, QA and Judge <-
 * `default`, and any role the host has not set borrows `default`. Separate
 * roles cost prompt-cache sharing between roles; that is the chosen trade.
 *
 * THE `COMPANY_DEFAULT_*` PAIR BELOW IS THE FALLBACK, NOT THE SOURCE. It applies
 * only when the host exposes neither the role's own host role nor `default`
 * (OMP absent, a CLI without `config`, a timeout, an unreadable payload);
 * `hostModelRoles.ts` falls
 * back per slot and reports `source: 'host' | 'mixed' | 'fallback'` so a board
 * running on these values says so. They were transcribed from ONE machine's
 * `modelRoles` (`plan: openai-codex/gpt-6.1-sol:max`, `default:
 * openai-codex/gpt-6-luna:xhigh`) and are verified against no host at all.
 */
export const COMPANY_DEFAULT_MODELS = {
  director: 'openai-codex/gpt-6.1-sol',
  advisor: 'openai-codex/gpt-6-luna',
  worker: 'openai-codex/gpt-6-luna',
  qa: 'openai-codex/gpt-6-luna',
  judge: 'openai-codex/gpt-6-luna',
  chat: 'openai-codex/gpt-6-luna',
} as const;

/**
 * Fallback efforts, paired one-for-one with {@link COMPANY_DEFAULT_MODELS} and
 * applied under the same rule: a host role that carries an `:effort` suffix
 * overrides this, a host role that carries none falls back to it.
 *
 * Kept out of the model id on purpose. The catalog lists `provider/model` and
 * reports the effort separately, and `ompRunner` passes `--model` and
 * `--thinking` as two flags, so `requestedModel` must stay bare or every catalog
 * lookup misses.
 */
export const COMPANY_FALLBACK_ROLE_THINKING = {
  director: 'max',
  advisor: 'xhigh',
  worker: 'xhigh',
  qa: 'xhigh',
  judge: 'xhigh',
  chat: 'xhigh',
} as const;

/** Deadline for the one `omp config get modelRoles` read that seeds a board. */
export const COMPANY_MODEL_ROLES_TIMEOUT_MS = 15_000;

/** Deadline for the one `omp models --json` read that lists the catalog. */
export const COMPANY_MODEL_CATALOG_TIMEOUT_MS = 30_000;
/**
 * How long one catalog read is reused. Every launch asks for the catalog, so a
 * short reuse keeps launches from each waiting on a fresh OMP process, and a
 * credential added since then shows up within a minute.
 */
export const COMPANY_MODEL_CATALOG_TTL_MS = 60_000;

// ── Usage + quota ────────────────────────────────────────────
/** At most one `omp usage` process per this window, whatever the caller asks. */
export const COMPANY_QUOTA_MIN_REFRESH_MS = 300_000;
/** A quota read that has not answered by now is killed, not awaited. */
export const COMPANY_QUOTA_TIMEOUT_MS = 20_000;

// ── Verification ─────────────────────────────────────────────
/** Applied when a Contract command declares no usable timeout of its own. */
export const COMPANY_VERIFICATION_DEFAULT_TIMEOUT_SECONDS = 600;
/** Ceiling on a single command's runtime, whatever the Contract declares. */
export const COMPANY_VERIFICATION_MAX_TIMEOUT_SECONDS = 900;
/** Per-stream capture ceiling; a chatty build is truncated, never unbounded. */
export const COMPANY_VERIFICATION_MAX_CAPTURE_BYTES = 512 * 1024;
/** Commands run per profile before the profile is treated as malformed. */
export const COMPANY_VERIFICATION_MAX_COMMANDS = 32;
/** Raw captured process output, stored verbatim without transcoding. */
export const COMPANY_VERIFICATION_OUTPUT_MEDIA_TYPE = 'text/plain; charset=utf-8';
