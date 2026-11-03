import { getTerminalColorMode, indexedColor, styleText, type TerminalColorScheme, type TerminalColors } from '@earendil-works/pi-tui';

export const bold = (text: string) => styleText(text, { bold: true }, getTerminalColorMode());
export const dim = (text: string) => styleText(text, { dim: true }, getTerminalColorMode());

/** Keep the terminal's background and text; only semantic accents use our palette. */
export class TuiTheme {
  private scheme?: TerminalColorScheme;
  private color(text: string, dark: number, light: number, fallback: number) {
    return styleText(text, { fg: indexedColor(this.scheme === 'dark' ? dark : this.scheme === 'light' ? light : fallback) }, getTerminalColorMode());
  }
  accent = (text: string) => this.color(text, 147, 97, 5);
  success = (text: string) => this.color(text, 114, 28, 2);
  warning = (text: string) => this.color(text, 179, 94, 3);
  danger = (text: string) => this.color(text, 167, 124, 1);
  setScheme(scheme: TerminalColorScheme) { this.scheme = scheme; }
  setColors(colors: TerminalColors) {
    const bg = colors.background;
    if (bg) this.scheme = (bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722) > 128 ? 'light' : 'dark';
  }
}
