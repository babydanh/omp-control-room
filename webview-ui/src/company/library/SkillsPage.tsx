import { useEffect, useMemo, useState } from 'react';

import { libraryStore } from './libraryClient.js';
import { useLibraryState } from './libraryStore.js';
import { LibraryEmpty, LibraryError, LibraryLoading, LibraryPage, LibraryToolbar } from './LibraryUi.js';

type SkillFilter = 'all' | 'omp' | 'claude' | 'agy' | 'single' | 'claude-on' | 'claude-name' | 'claude-off';

const FILTERS: { id: SkillFilter; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'omp', label: 'omp' },
  { id: 'claude', label: 'Claude' },
  { id: 'agy', label: 'agy' },
  { id: 'single', label: 'Chỉ có ở 1 nơi' },
  { id: 'claude-on', label: 'Claude: bật' },
  { id: 'claude-name', label: 'Claude: chỉ tên' },
  { id: 'claude-off', label: 'Claude: ẩn' },
];

export function SkillsPage() {
  const state = useLibraryState(libraryStore);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    libraryStore.requestSnapshot('skills');
  }, []);
  const skills = useMemo(() => state.skills?.skills ?? [], [state.skills]);
  const filteredSkills = useMemo(() => skills.filter((skill) => {
    const search = query.trim().toLocaleLowerCase();
    if (search && !`${skill.name} ${skill.description} ${skill.plugin ?? ''}`.toLocaleLowerCase().includes(search)) return false;
    switch (filter) {
      case 'omp': return skill.tools.includes('omp');
      case 'claude': return skill.tools.includes('claude');
      case 'agy': return skill.tools.includes('agy');
      case 'single': return skill.tools.length === 1;
      case 'claude-on': return skill.tools.includes('claude') && skill.claudeMode === 'on';
      case 'claude-name': return skill.tools.includes('claude') && skill.claudeMode === 'name-only';
      case 'claude-off': return skill.tools.includes('claude') && skill.claudeMode === 'off';
      default: return true;
    }
  }), [filter, query, skills]);
  const selectedSkill = skills.find((skill) => skill.id === selectedId);
  const preview = selectedId ? state.previews[selectedId] : undefined;
  const pending = Object.values(state.pending).some((request) =>
    request.type === 'librarySnapshotRequest' && request.section === 'skills',
  );
  const filters = FILTERS.map((item) => ({
    ...item,
    label: `${item.label} (${item.id === 'all' ? skills.length : skills.filter((skill) => {
      if (item.id === 'single') return skill.tools.length === 1;
      if (item.id === 'omp' || item.id === 'claude' || item.id === 'agy') return skill.tools.includes(item.id);
      if (item.id === 'claude-on') return skill.tools.includes('claude') && skill.claudeMode === 'on';
      if (item.id === 'claude-name') return skill.tools.includes('claude') && skill.claudeMode === 'name-only';
      if (item.id === 'claude-off') return skill.tools.includes('claude') && skill.claudeMode === 'off';
      return false;
    }).length})`,
  }));

  return (
    <LibraryPage
      title="Kho skill"
      description="Duyệt, tìm kiếm và xem trước các skill trên những công cụ AI của bạn."
    >
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel="Tìm skill"
        filters={filters}
        selectedFilter={filter}
        onFilterChange={(value) => setFilter(value as SkillFilter)}
      />
      {state.errors.skills && <LibraryError message={state.errors.skills} />}
      {pending && skills.length === 0 && <LibraryLoading label="Đang quét kho skill…" />}
      {!pending && !state.errors.skills && skills.length === 0 && (
        <LibraryEmpty
          title="Chưa có skill để hiển thị"
          description="Skill đã cài đặt sẽ xuất hiện tại đây để bạn tìm kiếm và xem nội dung."
        />
      )}
      {skills.length > 0 && (
        <div className="grid min-h-96 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.9fr)]">
          <div className="flex flex-col gap-2 overflow-y-auto">
            {filteredSkills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => {
                  setSelectedId(skill.id);
                  if (!state.previews[skill.id]) libraryStore.previewSkill(skill.id);
                }}
                aria-pressed={selectedId === skill.id}
                className={`rounded-(--company-radius-md) border p-4 text-left transition-colors ${selectedId === skill.id ? 'border-accent/60 bg-panel' : 'border-border bg-panel/60 hover:bg-panel'}`}
              >
                <span className="block truncate text-sm font-semibold text-text">{skill.name}</span>
                <span className="mt-1 line-clamp-2 block text-sm text-text-secondary">{skill.description || 'Chưa có mô tả.'}</span>
                <span className="mt-3 flex flex-wrap gap-1.5">
                  {skill.tools.map((tool) => <span key={tool} className="rounded-full bg-well px-2 py-0.5 text-xs text-text-secondary">{tool}</span>)}
                  {skill.tools.includes('claude') && <span className="rounded-full bg-well px-2 py-0.5 text-xs text-text-secondary">Claude: {skill.claudeMode}</span>}
                  {skill.plugin && <span className="rounded-full bg-well px-2 py-0.5 text-xs text-text-secondary">Plugin: {skill.plugin}</span>}
                </span>
              </button>
            ))}
            {filteredSkills.length === 0 && <LibraryEmpty title="Không tìm thấy skill" description="Thử đổi từ khóa hoặc bộ lọc." />}
          </div>
          <section className="min-h-96 overflow-hidden rounded-(--company-radius-md) border border-border bg-panel" aria-label="Xem trước skill">
            {selectedSkill ? (
              <>
                <header className="border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-text">{selectedSkill.name}</h2>
                </header>
                {state.errors[`skill:${selectedSkill.id}`] && <LibraryError message={state.errors[`skill:${selectedSkill.id}`]} />}
                {!preview ? <LibraryLoading label="Đang tải bản xem trước…" /> : (
                  <div className="h-[32rem] overflow-auto p-4">
                    {preview.truncated && <p className="mb-3 text-xs text-text-secondary">Nội dung đã được cắt ở giới hạn 64 KB.</p>}
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text">{preview.content}</pre>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full min-h-96 items-center justify-center p-6 text-center text-sm text-text-secondary">Chọn một skill để xem trước nội dung.</div>
            )}
          </section>
        </div>
      )}
    </LibraryPage>
  );
}
