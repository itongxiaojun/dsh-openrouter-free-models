import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate a module inside the installed DeepSeek Harness.
 *
 * The app's resource directory has moved between releases (`Resources/app` in
 * 0.1.5, `Resources/app.asar.unpacked` in 0.1.7), so the path is discovered
 * rather than hardcoded. Hardcoding it is how these tests silently started
 * skipping instead of failing, which is worse than either.
 *
 * @param specifier - path inside the harness, e.g. 'node_modules/@deepseek-ai/cordis/lib/index.js'.
 * @returns the absolute path, or `undefined` when no harness is installed.
 */
export function harnessPath(specifier) {
  const candidates = []
  const apps = '/Applications'
  if (existsSync(apps)) {
    for (const entry of readdirSync(apps)) {
      if (!entry.endsWith('.app')) continue
      if (!/dsh|deepseek|harness/i.test(entry)) continue
      const resources = join(apps, entry, 'Contents', 'Resources')
      if (!existsSync(resources)) continue
      for (const root of readdirSync(resources)) {
        if (root !== 'app' && root !== 'app.asar.unpacked') continue
        candidates.push(join(resources, root))
      }
    }
  }
  for (const root of candidates) {
    const candidate = join(root, specifier)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
