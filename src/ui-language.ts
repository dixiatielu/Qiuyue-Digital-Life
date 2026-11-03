import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Interface language is configured per process; English is the default. */
export function ui(english: string, chinese: string): string {
  return process.env.QIUYUE_UI_LANGUAGE?.toLowerCase() === 'zh' ? chinese : english;
}

/** Only this non-secret compatibility setting is exported to the process environment. */
export function loadUiLanguage(configPath: string) {
  let language: unknown;
  try { language = JSON.parse(readFileSync(configPath, 'utf8')).uiLanguage; } catch { /* the management page can repair it */ }
  const envPath = resolve(dirname(configPath), '.env');
  language ??= process.env.QIUYUE_UI_LANGUAGE ?? (existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')).QIUYUE_UI_LANGUAGE : undefined);
  if (language !== undefined) process.env.QIUYUE_UI_LANGUAGE = language === 'zh' ? 'zh' : 'en';
}
