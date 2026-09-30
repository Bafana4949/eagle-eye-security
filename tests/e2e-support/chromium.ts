/**
 * E2E TEST SUPPORT ONLY: which Chromium binary Playwright launches.
 *
 * No network access is allowed for browser downloads, so the runs use a Chromium that is
 * already in the Playwright cache (%LOCALAPPDATA%\ms-playwright on Windows,
 * ~/.cache/ms-playwright on Linux, or PLAYWRIGHT_BROWSERS_PATH). When the exact revision this
 * @playwright/test version expects is installed, Playwright's default is used; otherwise the
 * newest cached `chromium-<rev>` build. E2E_CHROMIUM_PATH overrides everything.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Flags every E2E browser gets: fake camera/microphone devices, no permission prompts. */
export const FAKE_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

function browsersRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

function expectedChromiumRevision(): string | null {
  try {
    const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    const browsers = (JSON.parse(readFileSync(file, 'utf8')) as { browsers: Array<{ name: string; revision: string }> }).browsers;
    return browsers.find((b) => b.name === 'chromium')?.revision ?? null;
  } catch {
    return null;
  }
}

function executableIn(dir: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'chrome-win64', 'chrome.exe'), path.join(dir, 'chrome-win', 'chrome.exe')]
      : process.platform === 'darwin'
        ? [
            path.join(dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
            path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
          ]
        : [path.join(dir, 'chrome-linux64', 'chrome'), path.join(dir, 'chrome-linux', 'chrome')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Executable path to pass to launchOptions, or undefined to let Playwright use its own
 * expected build. Returns undefined as well when nothing is cached (Playwright then reports
 * the missing browser clearly).
 */
export function resolveChromiumExecutable(): string | undefined {
  if (process.env.E2E_CHROMIUM_PATH) return process.env.E2E_CHROMIUM_PATH;
  const root = browsersRoot();
  if (!existsSync(root)) return undefined;
  const expected = expectedChromiumRevision();
  if (expected && existsSync(path.join(root, `chromium-${expected}`, 'INSTALLATION_COMPLETE'))) return undefined;
  const cached = readdirSync(root)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const match of cached) {
    const exe = executableIn(path.join(root, match[0]));
    if (exe) return exe;
  }
  return undefined;
}
