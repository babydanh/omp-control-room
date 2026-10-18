/**
 * AgentInfoTab: the Chi tiết tab of a company session or a herdr pane. It asks
 * the server for the agent's info when the tab opens, then shows what came back:
 * the folders it works in, its model, its tools grouped by where they come from,
 * its MCP servers, its skills, and how often each tool was used. A section the
 * source did not report says so rather than disappearing.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import type { AgentInfo } from '../../../../core/src/company.js';
import {
  collectedLine,
  ESTIMATED_MCP_LABEL,
  groupToolsBySource,
  matchesFilter,
  mcpGap,
  mcpServerViews,
  modelLine,
  skillsGap,
  sortSkills,
  toolsGap,
  usageBars,
  usageGap,
  workingFolder,
} from '../agentInfoView.js';
import { type CommandResultView, failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { CompanyButton } from './CompanyButton.js';

/**
 * Sends an info request now, and again on demand. The reply itself arrives as
 * state; this tracks only the request, so a refusal from the server can show.
 */
function useInfoRequest(
  send: () => CompanyCommandHandle,
  commandResults: Record<string, CommandResultView>,
): { failure: string | null; refresh: () => void } {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const handle = send();
    setRequestId(handle.requestId);
    setSendNotice(failureNotice(handle, 'Không gửi được yêu cầu.'));
  }, [send]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const outcome = requestId === null ? undefined : commandResults[requestId];
  return {
    failure: sendNotice ?? failureNotice(outcome, 'Máy chủ từ chối yêu cầu này.'),
    refresh,
  };
}

export interface SessionInfoTabProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  /** The details tab already shows a session's model, so the info tab can leave it out. */
  hideModel?: boolean;
}

/** What a company session reports about itself, asked for when the tab opens. */
export function SessionInfoTab({
  client,
  state,
  sessionId,
  hideModel = false,
}: SessionInfoTabProps) {
  const send = useCallback(() => client.requestSessionInfo(sessionId), [client, sessionId]);
  const { failure, refresh } = useInfoRequest(send, state.commandResults);
  return (
    <AgentInfoView
      info={state.sessionInfos[sessionId]}
      failure={failure}
      fallbackCwd={null}
      showModel={!hideModel}
      onRefresh={refresh}
    />
  );
}

export interface HerdrInfoTabProps {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
  /** The working folder herdr listed for the pane, used when the info has none. */
  fallbackCwd: string | null;
}

/** What a herdr agent reports about its pane, asked for when the tab opens. */
export function HerdrInfoTab({ client, state, paneId, fallbackCwd }: HerdrInfoTabProps) {
  const send = useCallback(() => client.requestHerdrInfo(paneId), [client, paneId]);
  const { failure, refresh } = useInfoRequest(send, state.commandResults);
  return (
    <AgentInfoView
      info={state.herdr.infos[paneId]}
      failure={failure}
      fallbackCwd={fallbackCwd}
      showModel
      onRefresh={refresh}
    />
  );
}

interface AgentInfoViewProps {
  info: AgentInfo | undefined;
  failure: string | null;
  fallbackCwd: string | null;
  showModel: boolean;
  onRefresh: () => void;
}

const NOT_YET_REPLIED =
  'Chưa có thông tin về agent này. Máy chủ trả lời sau khi nhận yêu cầu; nếu mãi không có, máy chủ có thể chưa hỗ trợ việc này — bấm Làm mới để thử lại.';

function AgentInfoView({ info, failure, fallbackCwd, showModel, onRefresh }: AgentInfoViewProps) {
  const [toolFilter, setToolFilter] = useState('');
  const [skillFilter, setSkillFilter] = useState('');

  return (
    <div
      data-testid="agent-info"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-2xs"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-text-muted">
          {info === undefined ? 'Chưa có thông tin.' : collectedLine(info)}
        </p>
        <CompanyButton size="sm" onClick={onRefresh}>
          Làm mới
        </CompanyButton>
      </div>
      {failure && (
        <p role="alert" className="text-warning">
          {failure}
        </p>
      )}
      {info === undefined ? (
        <p className="text-text-muted">{NOT_YET_REPLIED}</p>
      ) : (
        <>
          {info.note && <p className="text-text-muted">{info.note}</p>}
          <FoldersSection info={info} fallbackCwd={fallbackCwd} />
          {showModel && (
            <InfoSection title="Mô hình">
              <p className="text-text">{modelLine(info)}</p>
              {info.sessionFile && (
                <p className="truncate font-mono text-text-muted" title={info.sessionFile}>
                  {info.sessionFile}
                </p>
              )}
            </InfoSection>
          )}
          <ToolsSection info={info} filter={toolFilter} onFilter={setToolFilter} />
          <McpSection info={info} />
          <SkillsSection info={info} filter={skillFilter} onFilter={setSkillFilter} />
          <UsageSection info={info} />
        </>
      )}
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function FilterBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={label}
      className="rounded-(--company-radius-sm) bg-raised px-2 py-1 text-2xs text-text"
    />
  );
}

function FoldersSection({ info, fallbackCwd }: { info: AgentInfo; fallbackCwd: string | null }) {
  const folder = workingFolder(info) ?? fallbackCwd;
  return (
    <InfoSection title="Thư mục">
      <p className="truncate font-mono text-text" title={folder ?? undefined}>
        {folder ?? 'Chưa rõ thư mục làm việc.'}
      </p>
      {info.launchCwd && info.launchCwd !== folder && (
        <p className="truncate text-text-muted" title={info.launchCwd}>
          khởi chạy ở {info.launchCwd}
        </p>
      )}
    </InfoSection>
  );
}

function ToolsSection({
  info,
  filter,
  onFilter,
}: {
  info: AgentInfo;
  filter: string;
  onFilter: (value: string) => void;
}) {
  const gap = toolsGap(info);
  if (gap !== null) {
    return (
      <InfoSection title="Tool">
        <p className="text-text-muted">{gap}</p>
      </InfoSection>
    );
  }
  const groups = groupToolsBySource(
    (info.tools ?? []).filter((tool) => matchesFilter(tool.name, filter)),
  );
  return (
    <InfoSection title="Tool">
      <FilterBox label="Lọc tool" value={filter} onChange={onFilter} />
      {groups.length === 0 && <p className="text-text-muted">Không có tool nào khớp bộ lọc.</p>}
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <h4 className="text-text-muted">
            {group.label} · {group.activeCount}/{group.tools.length} đang bật
          </h4>
          <ul className="flex flex-wrap gap-1">
            {group.tools.map((tool) => (
              <li
                key={tool.name}
                className={`rounded-(--company-radius-sm) px-1.5 py-0.5 font-mono ${tool.active ? 'bg-accent/12 text-text' : 'bg-raised text-text-muted'}`}
              >
                {tool.name}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-text-muted">Khung sáng: tool đang bật.</p>
    </InfoSection>
  );
}

function McpSection({ info }: { info: AgentInfo }) {
  const gap = mcpGap(info);
  if (gap !== null) {
    return (
      <InfoSection title="Máy chủ MCP">
        <p className="text-text-muted">{gap}</p>
      </InfoSection>
    );
  }
  const servers = mcpServerViews(info.tools ?? [], info.toolUsage ?? []);
  return (
    <InfoSection title="Máy chủ MCP">
      {servers.map((server) => (
        <div key={server.name} className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-text">
            {server.name}
            {server.estimated && <span className="text-text-muted"> {ESTIMATED_MCP_LABEL}</span>}
          </span>
          <span className="shrink-0 text-text-muted">
            {server.toolCount} tool · {server.activeCount} đang bật
          </span>
          <span className={`shrink-0 ${server.used ? 'text-status-success' : 'text-text-muted'}`}>
            {server.used ? `đã dùng ${server.usageCount} lần` : 'chưa dùng'}
          </span>
        </div>
      ))}
    </InfoSection>
  );
}

function SkillsSection({
  info,
  filter,
  onFilter,
}: {
  info: AgentInfo;
  filter: string;
  onFilter: (value: string) => void;
}) {
  const gap = skillsGap(info);
  if (gap !== null) {
    return (
      <InfoSection title="Skill">
        <p className="text-text-muted">{gap}</p>
      </InfoSection>
    );
  }
  const skills = sortSkills(info.skills ?? []).filter((skill) => matchesFilter(skill.name, filter));
  return (
    <InfoSection title="Skill">
      <FilterBox label="Lọc skill" value={filter} onChange={onFilter} />
      {skills.length === 0 && <p className="text-text-muted">Không có skill nào khớp bộ lọc.</p>}
      <ul className="flex flex-col gap-1">
        {skills.map((skill) => (
          <li key={skill.name} className="px-2 py-1">
            <span className={skill.used ? 'font-semibold text-text' : 'text-text-muted'}>
              {skill.name}
            </span>
            {skill.used && <span className="ml-2 text-status-success">đã dùng</span>}
            {skill.description && (
              <span className="block text-text-muted">{skill.description}</span>
            )}
          </li>
        ))}
      </ul>
    </InfoSection>
  );
}

function UsageSection({ info }: { info: AgentInfo }) {
  const bars = usageBars(info.toolUsage ?? []);
  const message = usageGap(info) ?? (bars.length === 0 ? 'Chưa dùng tool nào.' : null);
  return (
    <InfoSection title="Dùng nhiều nhất">
      {message !== null && <p className="text-text-muted">{message}</p>}
      {bars.map((bar) => (
        <div key={bar.name} className="flex items-center gap-2">
          <span className="w-[40%] min-w-0 truncate font-mono text-text">{bar.name}</span>
          <span className="relative h-2 min-w-0 flex-1 rounded-full bg-raised">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              style={{ width: `${bar.share * 100}%` }}
            />
          </span>
          <span className="w-8 shrink-0 text-right font-mono text-text-muted">{bar.count}</span>
        </div>
      ))}
    </InfoSection>
  );
}
