import { useEffect, useMemo, useState } from 'react';

import { libraryStore } from './libraryClient.js';
import { useLibraryState } from './libraryStore.js';
import { LibraryCards, LibraryEmpty, LibraryError, LibraryLoading, LibraryPage, LibraryToolbar } from './LibraryUi.js';

const ACCOUNT_LABELS = {
  claude: 'Claude Code',
  agy: 'Antigravity agy',
  omp: 'omp',
} as const;

export function AccountsPage() {
  const [query, setQuery] = useState('');
  const [refreshRequestId, setRefreshRequestId] = useState('');
  const [loginRequestId, setLoginRequestId] = useState('');
  const library = useLibraryState(libraryStore);
  const snapshot = library.accounts;

  useEffect(() => {
    libraryStore.requestSnapshot('accounts');
  }, []);

  const accounts = useMemo(() => snapshot?.accounts ?? [], [snapshot]);
  const visibleAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return accounts;
    return accounts.filter((account) => {
      const searchable = [
        ACCOUNT_LABELS[account.tool],
        account.subscriptionType,
        account.orgName,
        account.email,
        account.reason,
        ...(account.providers ?? []),
      ].join(' ').toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
  }, [accounts, query]);

  const loading = Object.values(library.pending).some(
    (request) => request.type === 'librarySnapshotRequest' && request.section === 'accounts',
  );

  const loginResult = loginRequestId === '' ? undefined : library.commandResults[loginRequestId];

  const cards = visibleAccounts.map((account) => {
    const stateLabel = account.reason !== undefined
      ? 'Lỗi'
      : account.loggedIn
        ? 'Đã đăng nhập'
        : 'Chưa đăng nhập';
    const details = [
      account.subscriptionType === undefined ? '' : `Gói: ${account.subscriptionType}`,
      account.orgName === undefined ? '' : `Tổ chức: ${account.orgName}`,
      account.email === undefined ? '' : `Email: ${account.email}`,
      account.modelCount === undefined ? '' : `Số model: ${account.modelCount}`,
    ].filter(Boolean);
    return {
      id: account.tool,
      title: ACCOUNT_LABELS[account.tool],
      description: account.reason ?? stateLabel,
      detail: details.length > 0 ? details.join(' · ') : undefined,
      tags: [stateLabel, ...(account.authMethod === undefined ? [] : [`Phương thức: ${account.authMethod}`])],
    };
  });

  return (
    <LibraryPage
      title="Tài khoản"
      description="Trạng thái đăng nhập và thông tin tài khoản của các công cụ AI trên máy này."
    >
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded-(--company-radius-sm) border border-hairline bg-raised px-3 py-2 text-sm text-text transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
          disabled={loading}
          onClick={() => setRefreshRequestId(libraryStore.requestSnapshot('accounts', true))}
        >
          {loading ? 'Đang làm mới…' : 'Làm mới'}
        </button>
      </div>
      {refreshRequestId !== '' && library.pending[refreshRequestId] === undefined && (
        <p role="status" className="text-sm text-text-secondary">Đã cập nhật trạng thái tài khoản.</p>
      )}
      {loginResult !== undefined && (
        <p role={loginResult.ok ? 'status' : 'alert'} className="text-sm text-text-secondary">
          {loginResult.ok ? 'Đã mở cửa sổ đăng nhập.' : loginResult.reason ?? 'Không thể mở cửa sổ đăng nhập.'}
        </p>
      )}
      <LibraryToolbar query={query} onQueryChange={setQuery} searchLabel="Tìm tài khoản" />
      {library.errors.accounts !== undefined && <LibraryError message={library.errors.accounts} />}
      {loading && snapshot === null && <LibraryLoading label="Đang đọc trạng thái tài khoản…" />}
      {snapshot !== null && visibleAccounts.length > 0 && (
        <>
          <LibraryCards cards={cards} />
          {snapshot.accounts.some((account) => account.tool === 'omp') && (
            <section className="rounded-(--company-radius-md) border border-hairline bg-panel p-4">
              <h2 className="font-medium text-text">Nhà cung cấp omp</h2>
              {(snapshot.accounts.find((account) => account.tool === 'omp')?.credentials ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-text-secondary">Chưa có thông tin xác thực omp.</p>
              ) : (
                <ul className="mt-3 divide-y divide-hairline">
                  {snapshot.accounts.find((account) => account.tool === 'omp')?.credentials?.map((credential) => (
                    <li key={`${credential.provider}:${credential.credentialType}`} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium text-text">{credential.provider}</p>
                        <p className="mt-1 text-xs text-text-secondary">
                          Loại: {credential.credentialType}
                          {credential.disabled ? ' · Đã vô hiệu hóa' : ''}
                          {credential.disabledCause === undefined ? '' : ` · Lý do: ${credential.disabledCause}`}
                          {credential.blockedUntilMs === undefined ? '' : ` · Bị khóa đến ${formatDate(credential.blockedUntilMs)}`}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">Cập nhật: {formatDate(credential.updatedAt)}</p>
                      </div>
                      <button
                        type="button"
                        className="self-start rounded-(--company-radius-sm) border border-hairline px-3 py-1.5 text-xs text-text transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                        disabled={loginResult === undefined && library.pending[loginRequestId] !== undefined}
                        onClick={() => setLoginRequestId(libraryStore.loginAccount('omp', credential.provider))}
                      >
                        Đăng nhập lại
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            {(['claude', 'agy'] as const).map((tool) => (
              <button
                key={tool}
                type="button"
                className="rounded-(--company-radius-sm) border border-hairline px-3 py-2 text-sm text-text transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                disabled={library.pending[loginRequestId] !== undefined}
                onClick={() => setLoginRequestId(libraryStore.loginAccount(tool))}
              >
                Đăng nhập lại {ACCOUNT_LABELS[tool]}
              </button>
            ))}
          </div>
        </>
      )}
      {snapshot !== null && visibleAccounts.length === 0 && (
        <LibraryEmpty
          title={query.trim() ? 'Không tìm thấy tài khoản phù hợp' : 'Chưa có thông tin tài khoản'}
          description={query.trim() ? 'Thử từ khóa khác.' : 'Trạng thái Claude Code, agy và omp sẽ xuất hiện tại đây.'}
        />
      )}
    </LibraryPage>
  );
}

function formatDate(value: string | number): string {
  const timestamp = typeof value === 'number'
    ? value
    : /^\d+$/.test(value)
      ? Number(value)
      : undefined;
  const date = timestamp === undefined
    ? new Date(value)
    : new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('vi-VN');
}
