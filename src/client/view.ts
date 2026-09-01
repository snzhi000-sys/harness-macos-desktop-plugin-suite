/**
 * The React view for the dsh-docker status renderer: a table, collapsed by
 * default, expandable on click. `docker_logs` renders as a collapsed log
 * pane with the `truncated` flag surfaced so a capped pull never reads as
 * complete. The component consumes only `node.data` — it never scans the
 * Session window or other rendered nodes.
 *
 * @module dsh-docker/client/view
 */

import { createElement, useState, type ReactElement } from 'react';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { DockerStatusChatData, DockerStatusContainerRow, DockerStatusServiceRow } from './types.ts';

/** Status color for one engine state. */
function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return '#22c55e';
    case 'exited':
    case 'dead':
      return '#ef4444';
    case 'paused':
    case 'restarting':
      return '#f59e0b';
    default:
      return '#9ca3af';
  }
}

const styles = {
  root: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: '1.5' },
  header: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', padding: '4px 0' },
  caret: { width: '14px', display: 'inline-block', color: '#9ca3af' },
  dot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  title: { fontWeight: 600 },
  meta: { color: '#9ca3af', marginLeft: 'auto' },
  table: { borderCollapse: 'collapse', marginTop: '4px', width: '100%' },
  th: { textAlign: 'left', padding: '3px 8px 3px 0', color: '#9ca3af', fontWeight: 600, borderBottom: '1px solid rgba(128,128,128,0.25)' },
  td: { padding: '3px 8px 3px 0', borderBottom: '1px solid rgba(128,128,128,0.12)', verticalAlign: 'top', whiteSpace: 'nowrap' },
  pre: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflowY: 'auto', color: 'inherit' },
  note: { color: '#9ca3af', marginTop: '2px' },
} as const;

/** A collapsed-by-default expandable section. */
function Collapsible(props: { title: string; color: string; summary: string; children: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  return createElement(
    'div',
    { style: styles.root },
    createElement(
      'div',
      { style: styles.header, onClick: () => setOpen(!open), role: 'button', 'aria-expanded': open },
      createElement('span', { style: styles.caret }, open ? '▼' : '▶'),
      createElement('span', { style: { ...styles.dot, background: props.color } }),
      createElement('span', { style: styles.title }, props.title),
      createElement('span', { style: styles.meta }, props.summary),
    ),
    open ? props.children : null,
  );
}

/** Render the container/compose table body. */
export function Table({ rows }: { rows: readonly (DockerStatusContainerRow | DockerStatusServiceRow)[] }): ReactElement {
  const headers = ['name', 'state', 'status', 'ports'];
  return createElement(
    'table',
    { style: styles.table },
    createElement(
      'thead',
      null,
      createElement(
        'tr',
        null,
        headers.map((h) => createElement('th', { key: h, style: styles.th }, h)),
      ),
    ),
    createElement(
      'tbody',
      null,
      rows.map((row, index) => createElement(
        'tr',
        { key: `${row.name}-${index}` },
        createElement('td', { style: styles.td }, row.name),
        createElement(
          'td',
          { style: styles.td },
          createElement('span', { style: { color: stateColor(row.state) } }, row.state),
        ),
        createElement('td', { style: styles.td }, row.status ?? ''),
        createElement(
          'td',
          { style: styles.td },
          typeof row.ports === 'string' ? row.ports : (row.ports ?? []).join(', '),
        ),
      )),
    ),
  );
}

/** The docker_logs log pane. */
export function LogPane({ lines, truncated }: { lines: readonly string[]; truncated?: boolean }): ReactElement {
  return createElement(
    'div',
    null,
    createElement('pre', { style: styles.pre }, lines.length === 0 ? '(no log lines)' : lines.join('\n')),
    truncated === true ? createElement('div', { style: styles.note }, '▲ truncated: older lines were dropped by the tail cap') : null,
  );
}

/** The registered keyed Chat renderer. */
export function DockerStatusView({ node }: ChatNodeViewProps<'docker-status'>): ReactElement {
  const data: DockerStatusChatData = node.data;
  const rows = data.rows ?? [];
  const running = rows.filter((r) => r.state === 'running').length;
  const summary = !data.settled
    ? '…'
    : data.lines !== undefined
      ? `${data.lines.length} lines${data.truncated === true ? ' (truncated)' : ''}`
      : `${rows.length} service${rows.length === 1 ? '' : 's'} · ${running} up`;
  const color = !data.settled ? '#9ca3af' : rows.length === 0 || running > 0 ? (running > 0 ? '#22c55e' : '#9ca3af') : '#ef4444';

  return createElement(
    Collapsible,
    { title: data.title, color, summary, children: data.lines !== undefined
      ? createElement(LogPane, { lines: data.lines, truncated: data.truncated })
      : createElement(Table, { rows }) },
  );
}
