/**
 * WorkspaceFileBrowser: look at the workspace, without touching it.
 *
 * Everything here is a REQUEST to the server: the directory listing, the file
 * window, and any artifact the evidence points at. The browser never reads the
 * filesystem itself -- there is no filesystem in a webview, and a client-side
 * read would be both impossible and out of bounds.
 *
 * The two content kinds stay distinct on purpose. A UTF-8 page renders as text;
 * a base64 page renders as the byte count and media type the server reported,
 * because decoding an image as a string would look like corruption. Long files
 * and long artifacts are paged, and the view says when it is showing part of
 * something.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { decodeArtifact, describeFileContent } from '../artifactView.js';
import type { CompanyClient } from '../companyClient.js';
import { COMPANY_ARTIFACT_PAGE_BYTES } from '../constants.js';
import { useCompanyState } from '../useCompanyState.js';

export interface WorkspaceFileBrowserProps {
  client: CompanyClient;
  workspacePath: string;
  /** Artifact opened from an evidence link, when the user asked for one. */
  artifactId: string | null;
  onClearArtifact: () => void;
}

/** Bytes of a held artifact rendered at once; the rest is paged on demand. */
const ARTIFACT_RENDER_BYTES = COMPANY_ARTIFACT_PAGE_BYTES * 8;

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (next: string) => void }) {
  const crumbs = useMemo(() => {
    const parts = path === '' ? [] : path.split('/');
    return parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
    }));
  }, [path]);

  return (
    <nav
      aria-label="Đường dẫn không gian làm việc"
      className="flex flex-wrap items-center gap-1 text-2xs"
    >
      <button
        type="button"
        className="cursor-pointer text-accent-bright"
        onClick={() => onNavigate('')}
      >
        gốc không gian làm việc
      </button>
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <span className="text-text-muted">/</span>
          <button
            type="button"
            className="cursor-pointer text-accent-bright"
            onClick={() => onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function WorkspaceFileBrowser({
  client,
  workspacePath,
  artifactId,
  onClearArtifact,
}: WorkspaceFileBrowserProps) {
  const state = useCompanyState(client);
  const [path, setPath] = useState('');
  const [openFile, setOpenFile] = useState<string | null>(null);

  const listing = state.fileListings[path];
  const content = openFile === null ? undefined : state.fileContents[openFile];
  const described = content?.pages[0] ? describeFileContent(content.pages[0]) : null;
  const artifact = artifactId === null ? undefined : state.artifacts[artifactId];
  const artifactText = artifact ? decodeArtifact(artifact, ARTIFACT_RENDER_BYTES) : null;

  useEffect(() => {
    client.listFiles(path);
  }, [client, path]);

  useEffect(() => {
    if (artifactId !== null) client.requestArtifact(artifactId);
  }, [client, artifactId]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-browser">
      <header className="border-b-2 border-border p-2">
        <p className="truncate text-2xs text-text-muted" title={workspacePath}>
          {workspacePath || 'không có không gian làm việc'}
        </p>
        <Breadcrumbs path={path} onNavigate={setPath} />
      </header>

      {artifact && artifactText && (
        <section className="border-b-2 border-border p-2" aria-label="Tệp đính kèm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs uppercase tracking-wide text-text-muted">Tệp đính kèm</h3>
            <Button size="sm" onClick={onClearArtifact}>
              Đóng
            </Button>
          </div>
          <p className="text-2xs text-text-muted">
            {artifact.contentType} &middot; đang giữ {artifact.pages.length} trang,{' '}
            {artifact.totalBytes} byte
            {!artifact.eof && ' (vẫn đang tải)'}
            {artifactText.clipped && ' (đang hiển thị các trang đầu)'}
          </p>
          <pre className="mt-1 max-h-64 overflow-auto border-2 border-border bg-bg-dark p-2 text-2xs whitespace-pre-wrap text-text">
            {artifactText.text}
          </pre>
        </section>
      )}

      <ul className="flex-1 overflow-auto">
        {!listing && <li className="p-2 text-2xs text-text-muted">Đang tải...</li>}
        {listing?.entries.length === 0 && (
          <li className="p-2 text-2xs text-text-muted">Thư mục này trống.</li>
        )}
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="flex w-full cursor-pointer items-baseline justify-between gap-2 px-2 py-1 text-left text-sm text-text hover:bg-btn-hover"
              onClick={() => {
                if (entry.kind === 'directory') {
                  setPath(entry.path);
                } else {
                  setOpenFile(entry.path);
                  client.readFile(entry.path);
                }
              }}
            >
              <span>
                {entry.kind === 'directory' ? '[thư mục]' : '[tệp]'} {entry.name}
              </span>
              {entry.sizeBytes !== undefined && (
                <span className="text-2xs text-text-muted">{entry.sizeBytes} byte</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {openFile !== null && (
        <section className="border-t-2 border-border p-2" aria-label={`Tệp ${openFile}`}>
          <div className="flex items-center justify-between">
            <h3 className="truncate text-xs text-text">{openFile}</h3>
            <Button size="sm" onClick={() => setOpenFile(null)}>
              Đóng
            </Button>
          </div>
          {!content && <p className="text-2xs text-text-muted">Đang tải...</p>}
          {described?.kind === 'binary' && (
            <p className="text-2xs text-text-muted">
              Tệp nhị phân: {described.byteLength} byte
              {described.mediaType ? ` (${described.mediaType})` : ''}.
              {described.nextOffset !== null && ' Tải thêm bên dưới.'}
            </p>
          )}
          {described?.kind === 'text' && (
            <>
              <p className="text-2xs text-text-muted">
                đang hiển thị {described.byteLength} trong tổng số {described.totalBytes} byte
              </p>
              <pre className="mt-1 max-h-64 overflow-auto border-2 border-border bg-bg-dark p-2 text-2xs whitespace-pre-wrap text-text">
                {described.text}
              </pre>
            </>
          )}
          {described?.nextOffset !== null && described?.nextOffset !== undefined && (
            <Button
              size="sm"
              className="mt-1"
              onClick={() => client.readFile(openFile, described.nextOffset ?? 0)}
            >
              Tải thêm
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
