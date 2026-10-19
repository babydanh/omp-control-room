/**
 * StatusPill: the top bar's one place for the company's health. The pill shows a
 * single summary; its popover lists every reading. The popover closes on Escape,
 * on a press outside it, and when the pill is pressed again.
 */

import { Fragment, useEffect, useRef, useState } from 'react';

import { TRANSPORT_STATE_CONNECTED } from '../../../../core/src/constants.js';
import type { TransportState } from '../../../../core/src/transport.js';
import { transport } from '../../transport/index.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { BROWSER_SECTION_TITLE, statusPillView, type StatusRow } from '../statusPillView.js';
import { CompanyButton } from './CompanyButton.js';

/** The transport's connection, followed live so the pill can say when the board is cut off. */
function useConnection(): TransportState {
  const [connection, setConnection] = useState<TransportState>(transport.state);
  useEffect(() => transport.onStateChange(setConnection), []);
  return connection;
}

/** Two columns of readings: the label on the left, the value on the right. */
function StatusRows({ rows }: { rows: readonly StatusRow[] }) {
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1.5">
      {rows.map((row, index) => (
        <Fragment key={`${index}:${row.label}`}>
          <dt className="text-text-muted">{row.label}</dt>
          <dd className={`min-w-0 break-words ${row.attention ? 'text-warning' : 'text-text'}`}>
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function StatusPill({ client, state }: { client: CompanyClient; state: CompanyViewState }) {
  const connection = useConnection();
  const view = statusPillView(connection, state);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node && rootRef.current?.contains(target))) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const attention = view.tone === 'attention';
  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="company-status-pill"
        onClick={() => setOpen((current) => !current)}
        className={`company-toggle touch-target flex min-w-0 max-w-full items-center gap-1.5 ${
          attention ? 'text-warning' : ''
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            attention ? 'bg-warning' : 'bg-status-success'
          }`}
        />
        <span className="min-w-0 truncate">{view.summary}</span>
      </button>
      {open && (
        <div
          id="company-status-pill"
          role="dialog"
          aria-label="Trạng thái công ty"
          className="absolute right-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-1rem)] rounded-(--company-radius-md) border border-hairline bg-panel p-3 text-2xs"
        >
          <StatusRows rows={view.rows} />
          <section
            aria-label={BROWSER_SECTION_TITLE}
            className="mt-3 border-t border-hairline pt-2"
          >
            <h3 className="mb-1.5 text-text-muted">{BROWSER_SECTION_TITLE}</h3>
            <StatusRows rows={view.browsers.rows} />
            {view.browsers.reapable && (
              <CompanyButton
                size="sm"
                className="mt-2"
                disabled={connection !== TRANSPORT_STATE_CONNECTED}
                onClick={() => client.reapIdleBrowsers()}
              >
                Dọn ngay
              </CompanyButton>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
