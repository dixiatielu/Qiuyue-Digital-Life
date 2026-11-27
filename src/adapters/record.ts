import type { ChatRecordFormatter } from '../record-format.js';
import { snowlumaChatRecordFormatter } from './snowluma/record.js';
import { telegramChatRecordFormatter } from './telegram/record.js';

/** Built-in conversation formatters for platforms shipped with the runtime. */
export const builtinRecordFormatters: readonly ChatRecordFormatter[] = [
  snowlumaChatRecordFormatter,
  telegramChatRecordFormatter,
];
