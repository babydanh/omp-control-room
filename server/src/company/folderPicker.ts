/**
 * folderPicker: choosing a folder for the board. The board's page runs in a browser, which never
 * hands a folder's real path back, while the server runs on the user's own machine; so the server
 * opens Windows' own folder dialog (PowerShell's FolderBrowserDialog, with its "New folder"
 * button) and answers with the folder the user chose. It also checks a folder path a command
 * names and returns its canonical form.
 *
 * Every call takes injectable dependencies: production passes node:fs and a real process, tests
 * pass fakes. Refusals are {@link CompanyError}s whose code is a {@link FolderErrorCode} and whose
 * message is shown to the user as it stands.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CompanyError } from './companyError.js';

/** How long a folder dialog may stay open before it is closed and read as cancelled. */
export const FOLDER_PICK_TIMEOUT_MS = 15 * 60 * 1000;

const FOLDER_ERROR_MESSAGES = {
  folder_path_invalid: 'Đường dẫn không hợp lệ.',
  folder_not_found: 'Thư mục không tồn tại.',
  not_a_folder: 'Đây không phải thư mục.',
  folder_pick_unsupported: 'Hộp chọn thư mục chỉ có khi board chạy trên Windows. Hãy dán đường dẫn thư mục.',
  folder_pick_busy: 'Hộp chọn thư mục đang mở. Chọn xong hoặc đóng nó trước.',
  folder_pick_failed: 'Không mở được hộp chọn thư mục của Windows.',
} as const;

export type FolderErrorCode = keyof typeof FOLDER_ERROR_MESSAGES;

/** The file-system calls a folder check makes. */
export interface FolderFs {
  /** The platform whose path rules apply: drive paths on win32, `/` elsewhere. */
  readonly platform: NodeJS.Platform;
  realpath(target: string): Promise<string>;
  /** Follows symbolic links. */
  stat(target: string): Promise<{ isDirectory(): boolean }>;
}

/** The production file system. */
export const NODE_FOLDER_FS: FolderFs = {
  platform: process.platform,
  realpath: (target) => fs.promises.realpath(target),
  stat: (target) => fs.promises.stat(target),
};

/** What running the dialog's PowerShell gave back: nothing when the program is not installed. */
export type PickerRunResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ran'; readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** Runs one PowerShell with the dialog's script and the extra environment it reads. */
export type PickerRun = (
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<PickerRunResult>;

/**
 * The dialog script. The chosen path is printed on stdout and nothing is printed on cancel. The
 * title comes in through the environment, so no value is ever spliced into the script. A 1×1
 * borderless form owns the dialog. Windows keeps a background process from putting its windows in
 * front, so the dialog opened behind the browser; a timer on the dialog's own thread therefore
 * waits for it, joins the foreground window's input queue, and brings the dialog to the front,
 * top-most. The explicit exit stops PowerShell from lingering after the dialog closes.
 */
const PICK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object Windows.Forms.Form',
  "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Width = 1; $owner.Height = 1; $owner.StartPosition = 'CenterScreen'",
  '$owner.Show(); $owner.Activate()',
  "Add-Type -TypeDefinition @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class PickerWindow {',
  '  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);',
  '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);',
  '  // GW_ENABLEDPOPUP (6) is the dialog once it is up; HWND_TOPMOST (-1), SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW (0x43).',
  '  public static bool Raise(IntPtr owner) {',
  '    IntPtr dialog = GetWindow(owner, 6);',
  '    if (dialog == IntPtr.Zero || dialog == owner) return false;',
  '    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);',
  '    uint self = GetCurrentThreadId();',
  '    bool attached = foreground != 0 && foreground != self && AttachThreadInput(self, foreground, true);',
  '    SetWindowPos(dialog, new IntPtr(-1), 0, 0, 0, 0, 0x43);',
  '    BringWindowToTop(dialog);',
  '    SetForegroundWindow(dialog);',
  '    if (attached) AttachThreadInput(self, foreground, false);',
  '    return true;',
  '  }',
  '}',
  "'@",
  '$raise = New-Object Windows.Forms.Timer',
  '$raise.Interval = 100',
  '$raise.Add_Tick({ if ([PickerWindow]::Raise($owner.Handle)) { $raise.Stop() } })',
  '$raise.Start()',
  '$dialog = New-Object Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:PIXEL_AGENTS_PICK_TITLE',
  '$dialog.ShowNewFolderButton = $true',
  "if ($dialog.PSObject.Properties['UseDescriptionForTitle']) { $dialog.UseDescriptionForTitle = $true }",
  '$result = $dialog.ShowDialog($owner)',
  '$owner.Close()',
  'if ($result -eq [Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  '[Console]::Out.Flush()',
  '[Environment]::Exit(0)',
].join('\n');

const PICK_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PICK_SCRIPT];

/**
 * PowerShell 7 shows the current Explorer-style dialog; Windows PowerShell, always present, is the
 * fallback and shows the older tree dialog.
 */
const PICK_PROGRAMS = ['pwsh', 'powershell.exe'] as const;

const PICK_TITLE = 'Chọn thư mục cho Agent Board';

/**
 * The production runner: the console stays hidden, the dialog itself shows. Executor form: this
 * project's ES2022 lib has no Promise.withResolvers.
 */
export const runPickerProcess: PickerRun = (program, args, env) =>
  new Promise((resolve) => {
    execFile(
      program,
      [...args],
      { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: FOLDER_PICK_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ kind: 'missing' });
          return;
        }
        // A dialog left open past the timeout is killed: that reads as a cancel, with nothing printed.
        resolve({ kind: 'ran', ok: error === null || error.killed === true, stdout, stderr });
      },
    );
  });

function refuse(code: FolderErrorCode, cause?: unknown): CompanyError {
  return new CompanyError(
    code,
    FOLDER_ERROR_MESSAGES[code],
    cause === undefined ? undefined : { cause },
  );
}

/** The path rules of the platform the file system reports, not of the one running the tests. */
function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Check a folder path and return its canonical form. The path must be absolute for the platform
 * and must not contain a `..` segment, so the spelling cannot climb out of the folder it names.
 */
export async function resolveFolderPath(
  input: string,
  io: FolderFs = NODE_FOLDER_FS,
): Promise<string> {
  const p = pathApi(io.platform);
  if (input.includes('\0') || !p.isAbsolute(input) || input.split(/[\\/]/).includes('..')) {
    throw refuse('folder_path_invalid');
  }
  let canonical: string;
  try {
    canonical = await io.realpath(input);
  } catch (err) {
    throw refuse('folder_not_found', err);
  }
  let stats: { isDirectory(): boolean };
  try {
    stats = await io.stat(canonical);
  } catch (err) {
    throw refuse('folder_not_found', err);
  }
  if (!stats.isDirectory()) throw refuse('not_a_folder');
  return canonical;
}

/** Whether a folder dialog is open now: one at a time, so a second request cannot stack another. */
let picking = false;

/**
 * Open Windows' folder dialog on this machine and wait for the user. Returns the canonical path
 * of the folder chosen, or null when the dialog was cancelled or closed.
 */
export async function pickFolder(
  run: PickerRun = runPickerProcess,
  io: FolderFs = NODE_FOLDER_FS,
): Promise<string | null> {
  if (io.platform !== 'win32') throw refuse('folder_pick_unsupported');
  if (picking) throw refuse('folder_pick_busy');
  picking = true;
  try {
    for (const program of PICK_PROGRAMS) {
      const result = await run(program, PICK_ARGS, { PIXEL_AGENTS_PICK_TITLE: PICK_TITLE });
      if (result.kind === 'missing') continue;
      if (!result.ok) throw refuse('folder_pick_failed', result.stderr.trim() || undefined);
      const chosen = result.stdout.trim();
      return chosen === '' ? null : await resolveFolderPath(chosen, io);
    }
    throw refuse('folder_pick_failed');
  } finally {
    picking = false;
  }
}
