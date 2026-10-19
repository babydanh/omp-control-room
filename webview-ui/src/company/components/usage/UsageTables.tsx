/**
 * UsageTables: the token breakdowns by model, folder and agent type, and the model performance
 * table. Each one sorts on its headers; the defaults put the costliest or busiest rows first.
 */

import type { ReactNode } from 'react';

import type {
  UsageStatsAgentRow,
  UsageStatsFolderRow,
  UsageStatsMessage,
  UsageStatsModelPerformancePoint,
  UsageStatsModelRow,
} from '../../../../../core/src/messages.js';
import { formatCount, formatTokens, formatUsd, prettyFolder } from '../../usage/usageFormat.js';
import {
  costLabel,
  type ModelPerformanceRow,
  modelPerformanceRows,
  tokenSum,
} from '../../usage/usageStats.js';
import { milliText, speedText } from './usageMetrics.js';
import { type UsageColumn, UsageTable } from './UsageTable.js';

/**
 * An agent row carries no unpriced count, so a row with tokens and no cost reads as unpriced:
 * a priced model always costs something for its tokens.
 */
function agentCostText(row: UsageStatsAgentRow): string {
  if (row.totalCost === 0 && tokenSum(row) > 0) return 'chưa có giá';
  return formatUsd(row.totalCost);
}

const MODEL_COLUMNS: UsageColumn<UsageStatsModelRow>[] = [
  {
    key: 'model',
    label: 'Mô hình',
    textual: true,
    sortValue: (row) => row.model,
    cell: (row) => (
      <span className="whitespace-nowrap">
        {row.model} <span className="text-text-muted">· {row.provider}</span>
      </span>
    ),
  },
  {
    key: 'requests',
    label: 'Yêu cầu',
    align: 'end',
    sortValue: (row) => row.totals.totalRequests,
    cell: (row) => formatCount(row.totals.totalRequests),
  },
  {
    key: 'tokens',
    label: 'Token',
    align: 'end',
    sortValue: (row) => tokenSum(row.totals),
    cell: (row) => formatTokens(tokenSum(row.totals)),
  },
  {
    key: 'cost',
    label: 'Chi phí',
    align: 'end',
    sortValue: (row) => row.totals.totalCost,
    cell: (row) => costLabel(row.totals),
  },
];

const FOLDER_COLUMNS: UsageColumn<UsageStatsFolderRow>[] = [
  {
    key: 'folder',
    label: 'Thư mục',
    textual: true,
    sortValue: (row) => prettyFolder(row.folder),
    cell: (row) => prettyFolder(row.folder),
  },
  {
    key: 'requests',
    label: 'Yêu cầu',
    align: 'end',
    sortValue: (row) => row.totals.totalRequests,
    cell: (row) => formatCount(row.totals.totalRequests),
  },
  {
    key: 'tokens',
    label: 'Token',
    align: 'end',
    sortValue: (row) => tokenSum(row.totals),
    cell: (row) => formatTokens(tokenSum(row.totals)),
  },
  {
    key: 'cost',
    label: 'Chi phí',
    align: 'end',
    sortValue: (row) => row.totals.totalCost,
    cell: (row) => costLabel(row.totals),
  },
];

const AGENT_COLUMNS: UsageColumn<UsageStatsAgentRow>[] = [
  {
    key: 'agentType',
    label: 'Loại agent',
    textual: true,
    sortValue: (row) => row.agentType,
    cell: (row) => row.agentType,
  },
  {
    key: 'requests',
    label: 'Yêu cầu',
    align: 'end',
    sortValue: (row) => row.totalRequests,
    cell: (row) => formatCount(row.totalRequests),
  },
  {
    key: 'tokens',
    label: 'Token',
    align: 'end',
    sortValue: (row) => tokenSum(row),
    cell: (row) => formatTokens(tokenSum(row)),
  },
  {
    key: 'cost',
    label: 'Chi phí',
    align: 'end',
    sortValue: (row) => row.totalCost,
    cell: (row) => agentCostText(row),
  },
];

const PERFORMANCE_COLUMNS: UsageColumn<ModelPerformanceRow>[] = [
  {
    key: 'model',
    label: 'Mô hình',
    textual: true,
    sortValue: (row) => row.model,
    cell: (row) => row.model,
  },
  {
    key: 'provider',
    label: 'Nhà cung cấp',
    textual: true,
    sortValue: (row) => row.provider,
    cell: (row) => row.provider,
  },
  {
    key: 'requests',
    label: 'Yêu cầu',
    align: 'end',
    sortValue: (row) => row.requests,
    cell: (row) => formatCount(row.requests),
  },
  {
    key: 'ttft',
    label: 'Tới token đầu tiên',
    align: 'end',
    sortValue: (row) => row.avgTtft,
    cell: (row) => milliText(row.avgTtft),
  },
  {
    key: 'speed',
    label: 'Tốc độ',
    align: 'end',
    sortValue: (row) => row.avgTokensPerSecond,
    cell: (row) => speedText(row.avgTokensPerSecond),
  },
];

function TableBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

export function UsageTables({ data }: { data: UsageStatsMessage }) {
  return (
    <div className="flex flex-col gap-6">
      <TableBlock title="Theo mô hình">
        <UsageTable
          caption="Token theo mô hình"
          rows={data.byModel}
          columns={MODEL_COLUMNS}
          defaultKey="cost"
          rowKey={(row) => `${row.provider}/${row.model}`}
        />
      </TableBlock>
      <TableBlock title="Theo thư mục">
        <UsageTable
          caption="Token theo thư mục"
          rows={data.byFolder}
          columns={FOLDER_COLUMNS}
          defaultKey="cost"
          rowKey={(row) => row.folder}
        />
      </TableBlock>
      <TableBlock title="Theo loại agent">
        <UsageTable
          caption="Token theo loại agent"
          rows={data.byAgentType}
          columns={AGENT_COLUMNS}
          defaultKey="cost"
          rowKey={(row) => row.agentType}
        />
      </TableBlock>
    </div>
  );
}

export function ModelPerformanceTable({
  points,
}: {
  points: readonly UsageStatsModelPerformancePoint[];
}) {
  return (
    <TableBlock title="Hiệu năng theo mô hình">
      <UsageTable
        caption="Trung bình theo số yêu cầu của mỗi mô hình"
        rows={modelPerformanceRows(points)}
        columns={PERFORMANCE_COLUMNS}
        defaultKey="requests"
        rowKey={(row) => row.key}
      />
    </TableBlock>
  );
}
