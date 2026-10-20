import { useEffect, useState } from 'react';

import type { LibraryMcpServer } from '../../../../core/src/messages.js';
import { libraryStore } from './libraryClient.js';
import { useLibraryState } from './libraryStore.js';
import {
  LibraryEmpty,
  LibraryError,
  LibraryLoading,
  LibraryPage,
  LibraryToolbar,
} from './LibraryUi.js';

const TOOL_LABELS: Record<LibraryMcpServer['tools'][number], string> = {
  omp: 'omp',
  claude: 'Claude',
  agy: 'agy',
};

const STATUS_LABELS: Record<LibraryMcpServer['status'], string> = {
  connected: 'Đã kết nối',
  error: 'Lỗi kết nối',
  unchecked: 'Chưa kiểm tra',
};

const TRANSPORT_LABELS: Record<LibraryMcpServer['transport'], string> = {
  stdio: 'Lệnh cục bộ',
  http: 'HTTP',
  sse: 'SSE',
};

export function McpPage() {
  const state = useLibraryState(libraryStore);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [checkingRequestId, setCheckingRequestId] = useState<string>();
  const [checkingName, setCheckingName] = useState<string>();

  useEffect(() => {
    libraryStore.requestSnapshot('mcp');
  }, []);

  const snapshot = state.mcp;
  const isLoading = snapshot === null && Object.values(state.pending).some((request) => request.type === 'librarySnapshotRequest' && request.section === 'mcp');
  const servers = (snapshot?.servers ?? []).filter((server) => {
    const matchesTool = filter === 'all' || server.tools.includes(filter as LibraryMcpServer['tools'][number]);
    const search = `${server.name} ${server.commandName ?? ''} ${server.endpoint ?? ''}`.toLocaleLowerCase();
    return matchesTool && search.includes(query.trim().toLocaleLowerCase());
  });
  const commandResult = checkingRequestId ? state.commandResults[checkingRequestId] : undefined;
  const isChecking = checkingRequestId !== undefined && commandResult === undefined;

  function checkConnection(name: string) {
    setCheckingName(name);
    setCheckingRequestId(libraryStore.checkMcp(name));
  }

  useEffect(() => {
    if (commandResult?.ok) libraryStore.requestSnapshot('mcp', true);
  }, [commandResult]);

  return (
    <LibraryPage
      title="MCP"
      description="Xem các máy chủ MCP đã cấu hình cho omp, Claude và agy."
    >
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel="Tìm máy chủ MCP"
        filters={[
          { id: 'all', label: 'Tất cả công cụ' },
          { id: 'omp', label: 'omp' },
          { id: 'claude', label: 'Claude' },
          { id: 'agy', label: 'agy' },
        ]}
        selectedFilter={filter}
        onFilterChange={setFilter}
      />
      {state.errors.mcp && <LibraryError message={state.errors.mcp} />}
      {commandResult && !commandResult.ok && (
        <LibraryError message={commandResult.reason ?? 'Không thể kiểm tra kết nối.'} />
      )}
      {snapshot?.reason && <LibraryError message={snapshot.reason} />}
      {isLoading && <LibraryLoading label="Đang đọc cấu hình MCP…" />}
      {!isLoading && servers.length === 0 && (
        <LibraryEmpty
          title={snapshot ? 'Không tìm thấy máy chủ MCP' : 'Chưa có máy chủ MCP'}
          description={snapshot
            ? 'Thử đổi bộ lọc hoặc từ khóa tìm kiếm.'
            : 'Các máy chủ đã cấu hình sẽ xuất hiện tại đây.'}
        />
      )}
      {servers.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <li
              key={server.name}
              className="rounded-(--company-radius-md) border border-hairline bg-panel p-4 transition-colors duration-150 hover:border-border hover:bg-raised motion-reduce:transition-none"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 break-words font-medium text-text">{server.name}</h2>
                <span className={`shrink-0 rounded-full px-2 py-1 text-2xs ${
                  server.status === 'connected'
                    ? 'bg-status-success/10 text-status-success'
                    : server.status === 'error'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-well text-text-muted'
                }`}>
                  {STATUS_LABELS[server.status]}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {server.tools.map((tool) => (
                  <span key={tool} className="rounded-full bg-well px-2 py-1 text-2xs text-text-muted">
                    {TOOL_LABELS[tool]}
                  </span>
                ))}
                <span className="rounded-full bg-well px-2 py-1 text-2xs text-text-muted">
                  {TRANSPORT_LABELS[server.transport]}
                </span>
              </div>
              <p className="mt-3 break-all text-xs text-text-secondary">
                {server.transport === 'stdio'
                  ? server.commandName ?? 'Lệnh không xác định'
                  : server.endpoint ?? 'Địa chỉ không xác định'}
              </p>
              <button
                type="button"
                className="mt-4 rounded-(--company-radius-sm) border border-border px-3 py-2 text-xs font-medium text-text transition-colors hover:bg-well disabled:cursor-wait disabled:opacity-60"
                onClick={() => checkConnection(server.name)}
                disabled={isChecking}
              >
                {isChecking && checkingName === server.name ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </LibraryPage>
  );
}
