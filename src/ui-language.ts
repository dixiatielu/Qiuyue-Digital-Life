/** Interface language is configured per process; English is the default. */
export function ui(english: string, chinese: string): string {
  return process.env.QIUYUE_UI_LANGUAGE?.toLowerCase() === 'zh' ? chinese : english;
}
