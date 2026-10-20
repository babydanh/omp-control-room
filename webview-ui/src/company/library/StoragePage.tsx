import { useEffect, useMemo, useState } from 'react';

import type { LibraryStorageResult } from '../../../../core/src/messages.js';
import { serverToken } from '../../transport/serverToken.js';
import { libraryStore } from './libraryClient.js';
import type { LibraryStorageKind } from './libraryStore.js';
import { useLibraryState } from './libraryStore.js';
import { LibraryCards, LibraryEmpty, LibraryError, LibraryLoading, LibraryPage, LibraryToolbar } from './LibraryUi.js';

const TABS: ReadonlyArray<{ id: LibraryStorageKind; label: string }> = [
  { id: 'workItems', label: 'Việc cũ' },
  { id: 'sessions', label: 'Phiên' },
  { id: 'openViking', label: 'OpenViking' },
  { id: 'proofs', label: 'Proof' },
];
const AGENT_TYPES = [
  { id: '', label: 'Mọi loại' },
  { id: 'main', label: 'Main' },
  { id: 'sub', label: 'Sub' },
  { id: 'claude', label: 'Claude' },
  { id: 'agy', label: 'agy' },
] as const;

export function StoragePage() {
  const [kind, setKind] = useState<LibraryStorageKind>('workItems');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [agentType, setAgentType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [restoreId, setRestoreId] = useState('');
  const [restoreRequestId, setRestoreRequestId] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const library = useLibraryState(libraryStore);
  const result = library.storage[kind];
  const restoreResult = restoreRequestId === '' ? undefined : library.commandResults[restoreRequestId];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      libraryStore.searchStorage(kind, {
        query: query.slice(0, 200),
        ...(repo === '' ? {} : { repo }),
        ...(agentType === '' ? {} : { agentType: agentType as 'main' | 'sub' | 'claude' | 'agy' }),
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [kind, query, repo, agentType, from, to]);

  useEffect(() => {
    if (restoreResult === undefined) return;
    setRestoreId('');
    setRestoreRequestId('');
    if (restoreResult.ok) {
      setRestoreError('');
      libraryStore.searchStorage('workItems', { query });
    } else {
      setRestoreError(restoreResult.reason ?? 'Không thể khôi phục việc.');
    }
  }, [query, restoreResult]);

  const loading = Object.values(library.pending).some(
    (request) => request.type === 'libraryStorageSearchRequest' && request.kind === kind,
  );
  const error = library.errors.storage;
  const visibleResults = useMemo(() => result?.results ?? [], [result]);
  function restore(itemId: string): void {
    setRestoreId(itemId);
    setRestoreError('');
    setRestoreRequestId(libraryStore.restoreWorkItem(itemId));
  }

  const cards = visibleResults.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    detail: storageDetail(entry),
    tags: [entry.status, entry.repo, entry.assignee, entry.uri].filter((tag): tag is string => Boolean(tag)),
    ...(kind === 'workItems'
      ? { action: { label: restoreId === entry.id ? 'Đang khôi phục…' : 'Khôi phục', onClick: () => restore(entry.id), disabled: restoreId === entry.id } }
      : {}),
  }));

  return (
    <LibraryPage title="Lưu trữ" description="Tìm việc cũ, phiên làm việc, OpenViking và minh chứng kiểm thử.">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel={kind === 'openViking' ? 'Tìm trong OpenViking' : 'Tìm trong lưu trữ'}
        filters={TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
        selectedFilter={kind}
        onFilterChange={(value) => setKind(value as LibraryStorageKind)}
      />
      {kind === 'workItems' && (
        <label className="mb-5 grid max-w-sm gap-1 text-xs text-text-secondary">Repo
          <input value={repo} onChange={(event) => setRepo(event.target.value)} className="rounded-(--company-radius-sm) border border-hairline bg-panel px-3 py-2 text-text" placeholder="Đường dẫn repo" />
        </label>
      )}
      {kind === 'sessions' && (
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-text-secondary">Loại agent
            <select value={agentType} onChange={(event) => setAgentType(event.target.value)} className="rounded-(--company-radius-sm) border border-hairline bg-panel px-3 py-2 text-text">
              {AGENT_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-text-secondary">Repo
            <input value={repo} onChange={(event) => setRepo(event.target.value)} className="rounded-(--company-radius-sm) border border-hairline bg-panel px-3 py-2 text-text" placeholder="Đường dẫn repo" />
          </label>
          <label className="grid gap-1 text-xs text-text-secondary">Từ ngày
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="rounded-(--company-radius-sm) border border-hairline bg-panel px-3 py-2 text-text" />
          </label>
          <label className="grid gap-1 text-xs text-text-secondary">Đến ngày
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="rounded-(--company-radius-sm) border border-hairline bg-panel px-3 py-2 text-text" />
          </label>
        </div>
      )}
      {error && <LibraryError message={error} />}
      {restoreError && <LibraryError message={restoreError} />}
      {loading && visibleResults.length === 0 ? <LibraryLoading label="Đang tìm trong lưu trữ…" /> : null}
      {!loading && visibleResults.length === 0 && !error ? (
        <LibraryEmpty title="Chưa có mục phù hợp" description="Thử đổi nội dung tìm kiếm hoặc bộ lọc." />
      ) : null}
      {kind === 'proofs' && visibleResults.some((entry) => entry.proofUrl) && (
        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleResults.map((entry) => entry.proofUrl && <ProofCard key={entry.id} proof={entry} />)}
        </div>
      )}
      {(kind !== 'proofs' || visibleResults.every((entry) => !entry.proofUrl)) && <LibraryCards cards={cards} />}
    </LibraryPage>
  );
}

function storageDetail(entry: LibraryStorageResult): string | undefined {
  const details = [entry.cwd, entry.timestamp ? formatDate(entry.timestamp) : undefined,
    entry.editedFileCount === undefined ? undefined : `${entry.editedFileCount} tệp đã sửa`,
    entry.transcriptPath, entry.score === undefined ? undefined : `Điểm ${entry.score}`];
  return details.filter(Boolean).join(' · ') || undefined;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('vi-VN');
}

function ProofCard({ proof }: { proof: LibraryStorageResult }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const isImage = proof.mediaType?.startsWith('image/') ?? false;
  const isVideo = proof.mediaType?.startsWith('video/') ?? false;

  useEffect(() => {
    if ((!isImage && !isVideo) || !proof.proofUrl) return;
    let disposed = false;
    let createdUrl: string | null = null;
    const headers = serverToken === null ? undefined : { Authorization: `Bearer ${serverToken}` };
    void fetch(proof.proofUrl, { headers }).then((response) => {
      if (!response.ok) throw new Error('Tải minh chứng thất bại');
      return response.blob();
    }).then((blob) => {
      if (disposed) return;
      createdUrl = URL.createObjectURL(blob);
      setObjectUrl(createdUrl);
    }).catch(() => setObjectUrl(null));
    return () => {
      disposed = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [isImage, isVideo, proof.proofUrl]);

  async function download(): Promise<void> {
    if (!proof.proofUrl) return;
    const headers = serverToken === null ? undefined : { Authorization: `Bearer ${serverToken}` };
    const response = await fetch(proof.proofUrl, { headers });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = proof.title;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <article className="overflow-hidden rounded-(--company-radius-md) border border-hairline bg-panel p-4">
      <h3 className="mb-2 truncate font-medium text-text" title={proof.title}>{proof.title}</h3>
      {isImage && objectUrl && <img src={objectUrl} alt={proof.title} className="max-h-80 w-full rounded-(--company-radius-sm) object-contain" />}
      {isVideo && objectUrl && <video src={objectUrl} controls className="max-h-80 w-full rounded-(--company-radius-sm)" />}
      {(isImage || isVideo) && !objectUrl && <p className="text-sm text-text-secondary">Đang tải xem trước…</p>}
      <p className="mt-2 break-all text-xs text-text-secondary">{proof.timestamp ? formatDate(proof.timestamp) : proof.description}</p>
      <button type="button" onClick={() => void download()} className="mt-3 rounded-(--company-radius-sm) border border-hairline px-3 py-2 text-sm text-text hover:bg-raised">
        {isImage || isVideo ? 'Tải xuống' : 'Mở / tải xuống'}
      </button>
    </article>
  );
}
