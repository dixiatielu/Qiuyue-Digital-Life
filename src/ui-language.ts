import { readFileSync } from 'node:fs';

let language: 'en' | 'zh' = 'en';
/** Interface language comes from this process's configuration; English is the default. */
export function ui(english: string, chinese: string): string {
  return language === 'zh' ? chinese : english;
}
export function loadUiLanguage(configPath: string) {
  language = 'en';
  try { language = JSON.parse(readFileSync(configPath, 'utf8')).uiLanguage === 'zh' ? 'zh' : 'en'; }
  catch { /* The management page can repair an unreadable configuration. */ }
}
