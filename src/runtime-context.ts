import type { Action } from './domain.js';

/** Provenance and deduplication metadata stay in SQLite, available through inspect_actions(id). */
export function actionSummary(action: Action, previewLength = 2000) {
  const preview = (value: unknown) => {
    const text = JSON.stringify(value);
    return text && text.length > previewLength ? { preview: text.slice(0, previewLength), truncated: true } : value;
  };
  return { id: action.id, kind: action.kind, args: preview(action.args), status: action.status, result: preview(action.result), createdAt: action.createdAt };
}

export type RuntimeSnapshot = Record<string, unknown>;
type Entry = { id: string };
type ArrayUpdate = { upsert: Entry[]; removedIds: string[] };
const collections = new Set(['recentEvents', 'recalled', 'actualActions', 'activeCommitmentsAndPlans', 'pursuits', 'myHabits', 'practices', 'impressions']);
/** Memories runtime_data has brought stay in the working context until compaction, so a delta removes one only when it no longer holds. */
const lasting = ['recalled', 'myHabits', 'practices', 'impressions'];
/** Recent events come with the observations that bring them; only a snapshot, which stands in for compacted exchanges, lists them. */
const snapshotOnly = new Set(['recentEvents']);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keep the warm message prefix intact; only changed fields and records are appended. */
export function runtimeUpdate(current: RuntimeSnapshot, previous?: RuntimeSnapshot): RuntimeSnapshot | undefined {
  if (!previous) return { format: 'snapshot', ...current };
  const changes: RuntimeSnapshot = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === 'now' || snapshotOnly.has(key) || equal(value, previous[key])) continue;
    if (collections.has(key)) {
      const before = new Map(((previous[key] ?? []) as Entry[]).map(item => [item.id, item]));
      const after = value as Entry[];
      const ids = new Set(after.map(item => item.id));
      const update: ArrayUpdate = { upsert: after.filter(item => !equal(item, before.get(item.id))), removedIds: [...before.keys()].filter(id => !ids.has(id)) };
      if (update.upsert.length || update.removedIds.length) changes[key] = update;
    } else changes[key] = value;
  }
  return Object.keys(changes).length ? { format: 'delta', now: current.now, ...changes } : undefined;
}

/**
 * What a delta brings the working context to, from what it already shows. A memory already shown stays as shown while it holds,
 * even when what is said no longer calls it to mind, since its earlier upsert is still in the context; an action keeps its latest outcome.
 */
export function carry(current: RuntimeSnapshot, shown: RuntimeSnapshot, holding: (memoryIds: string[]) => Set<string>): RuntimeSnapshot {
  const view: RuntimeSnapshot = { ...current };
  const held = holding(lasting.flatMap(key => ((shown[key] ?? []) as Entry[]).map(item => item.id)));
  for (const key of lasting) {
    const before = (shown[key] ?? []) as Entry[];
    const ids = new Set(before.map(item => item.id));
    view[key] = [...before.filter(item => held.has(item.id)), ...((current[key] ?? []) as Entry[]).filter(item => !ids.has(item.id))];
  }
  const actions = new Map(((shown.actualActions ?? []) as Entry[]).map(action => [action.id, action]));
  for (const action of (current.actualActions ?? []) as Entry[]) actions.set(action.id, action);
  view.actualActions = [...actions.values()];
  return view;
}

/** Rebuild the exact baseline after restart or rollback, without forcing another full snapshot. */
export function applyRuntimeUpdate(previous: RuntimeSnapshot | undefined, update: RuntimeSnapshot): RuntimeSnapshot {
  const { format, ...fields } = update;
  if (format !== 'delta') return fields;
  const current = { ...previous };
  for (const [key, value] of Object.entries(fields)) {
    if (!collections.has(key)) { current[key] = value; continue; }
    const { upsert, removedIds } = value as ArrayUpdate;
    const items = new Map(((current[key] ?? []) as Entry[]).map(item => [item.id, item]));
    for (const id of removedIds) items.delete(id);
    for (const item of upsert) items.set(item.id, item);
    current[key] = [...items.values()];
  }
  return current;
}
