import { projectActionDisplay, type DisplayMessage, type DisplayProjector, type MediaPreviewResolver } from '../display-message.js';
import { snowlumaDisplayProjector } from './snowluma/display.js';
import { telegramDisplayProjector } from './telegram/display.js';

/** Built-in display projectors for historical and live records across built-in platform adapters. */
export const builtinDisplayProjectors: readonly DisplayProjector[] = [
  snowlumaDisplayProjector,
  telegramDisplayProjector,
];

/** Project an outgoing action across the given display projectors (defaulting to built-in adapters). */
export function outgoingMessage(
  kind: string,
  args: Record<string, unknown>,
  projectors: readonly DisplayProjector[] = builtinDisplayProjectors,
  preview?: MediaPreviewResolver,
): DisplayMessage | undefined {
  return projectActionDisplay(
    { id: '', key: '', fingerprint: '', kind, args, sources: [], status: 'pending', result: null, createdAt: 0 },
    projectors,
    preview,
  ).message;
}
