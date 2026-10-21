import { useEffect } from 'react';

import type { LibraryClaudeRole } from '../../../../core/src/messages.js';
import { libraryStore } from './libraryClient.js';
import { useLibraryState } from './libraryStore.js';
import { LibraryEmpty, LibraryError, LibraryLoading } from './LibraryUi.js';

const GROUPS: { source: LibraryClaudeRole['source']; title: string }[] = [
  { source: 'builtin', title: 'Có sẵn' },
  { source: 'user', title: 'Role riêng' },
  { source: 'plugin', title: 'Plugin' },
];
const MODELS = ['inherit', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function RoleRow({ role, saving }: { role: LibraryClaudeRole; saving: boolean }) {
  return (
    <tr className="border-t border-border align-middle">
      <th scope="row" className="max-w-48 px-3 py-3 text-left text-sm font-medium text-text">
        <span className="block truncate" title={role.name}>{role.name}</span>
      </th>
      <td className="max-w-72 px-3 py-3 text-sm text-text-secondary">
        <span className="block truncate" title={role.description}>{role.description || 'Chưa có mô tả.'}</span>
      </td>
      <td className="px-3 py-3 text-sm text-text-secondary">
        {role.editable ? (
          <select
            aria-label={`Model của ${role.name}`}
            className="rounded border border-border bg-well px-2 py-1 text-text"
            value={role.model}
            disabled={saving}
            onChange={(event) => libraryStore.setClaudeRole(role.name, { model: event.currentTarget.value })}
          >
            {MODELS.map((model) => <option key={model} value={model}>{model === 'inherit' ? 'Theo phiên chính' : model}</option>)}
            {role.model.startsWith('claude-') && !MODELS.includes(role.model) && <option value={role.model}>{role.model}</option>}
          </select>
        ) : <span>{role.model === 'inherit' ? 'Theo phiên chính' : role.model}</span>}
      </td>
      <td className="px-3 py-3 text-sm text-text-secondary">
        {role.editable ? (
          <select
            aria-label={`Effort của ${role.name}`}
            className="rounded border border-border bg-well px-2 py-1 text-text"
            value={role.effort ?? ''}
            disabled={saving}
            onChange={(event) => libraryStore.setClaudeRole(role.name, { effort: event.currentTarget.value || null })}
          >
            <option value="">Theo phiên</option>
            {EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        ) : <span>{role.effort ?? 'Theo phiên'}</span>}
      </td>
      <td className="px-3 py-3 text-center text-sm text-text-secondary">{role.writesFiles ? 'Có' : 'Không'}</td>
      <td className="px-3 py-3 text-center">
        <input
          type="checkbox"
          aria-label={`${role.enabled ? 'Tắt' : 'Bật'} ${role.name}`}
          checked={role.enabled}
          disabled={saving}
          onChange={(event) => libraryStore.setClaudeRole(role.name, { enabled: event.currentTarget.checked })}
        />
      </td>
    </tr>
  );
}

export function ClaudeRolesPage() {
  const state = useLibraryState(libraryStore);
  useEffect(() => { libraryStore.requestSnapshot('claudeRoles'); }, []);
  const roles = state.claudeRoles?.roles ?? [];
  const loading = Object.values(state.pending).some((request) =>
    request.type === 'librarySnapshotRequest' && request.section === 'claudeRoles',
  );
  const saving = Object.values(state.pending).some((request) => request.type === 'libraryClaudeRoleSet');

  return (
    <div className="flex flex-col gap-4">
      {state.errors.claudeRoles && <LibraryError message={state.errors.claudeRoles} />}
      {state.errors['command:setClaudeRole'] && <LibraryError message={state.errors['command:setClaudeRole']} />}
      {saving && <p role="status" className="text-sm text-text-secondary">Đang lưu thay đổi…</p>}
      {loading && roles.length === 0 && <LibraryLoading label="Đang quét role Claude…" />}
      {!loading && !state.errors.claudeRoles && roles.length === 0 && (
        <LibraryEmpty title="Chưa có role Claude" description="Role cài đặt sẽ xuất hiện tại đây." />
      )}
      {roles.length > 0 && GROUPS.map((group) => {
        const members = roles.filter((role) => role.source === group.source);
        if (!members.length) return null;
        return (
          <section key={group.source} className="overflow-hidden rounded-(--company-radius-md) border border-border bg-panel" aria-label={group.title}>
            <h2 className="px-4 py-3 text-sm font-semibold text-text">{group.title}</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse">
                <thead><tr className="bg-well text-left text-xs text-text-secondary">
                  <th className="px-3 py-2">Tên</th><th className="px-3 py-2">Mô tả ngắn</th>
                  <th className="px-3 py-2">Model</th><th className="px-3 py-2">Effort</th>
                  <th className="px-3 py-2 text-center">Sửa file</th><th className="px-3 py-2 text-center">Bật</th>
                </tr></thead>
                <tbody>{members.map((role) => <RoleRow key={role.id} role={role} saving={saving} />)}</tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
