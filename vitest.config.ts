import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig, type Plugin } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Transform standard TypeScript decorators before Vite's default parser sees
 * source files (mirrors the harness `standardDecoratorPlugin`).
 * @returns a pre-transform Vite plugin for source-mode tests.
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

/**
 * The browser client tests exercise the dsh client runtime the same way the
 * harness does: through its source tree. The published npm artifacts are
 * browser closure bundles (`window.__ModuleLoader__.load`) that only run
 * inside the real web client, and the harness `tsconfig.base.json` paths map
 * is the resolution facade its own tests use. This plugin applies that map to
 * every module regardless of importer location (vite-tsconfig-paths scopes to
 * files inside the tsconfig tree, which excludes this repository).
 * Point DSH_HARNESS_ROOT at a deepseek-harness checkout when it is not the
 * sibling of this repository.
 * @returns a pre-resolve Vite plugin, or undefined when no harness checkout is present.
 */
function harnessPathsPlugin(): Plugin | undefined {
  const harnessRoot = process.env.DSH_HARNESS_ROOT !== undefined && process.env.DSH_HARNESS_ROOT !== ''
    ? process.env.DSH_HARNESS_ROOT
    : resolve(import.meta.dirname, '..', 'deepseek-harness-latest')
  const baseConfig = resolve(harnessRoot, 'tsconfig.base.json')
  if (!existsSync(baseConfig)) return undefined
  const raw = ts.readConfigFile(baseConfig, ts.sys.readFile)
  const paths = raw.config.compilerOptions?.paths as Record<string, readonly string[]> | undefined
  if (paths === undefined) return undefined
  const entries = Object.entries(paths)
    .filter(([, targets]) => targets.length > 0)
    .map(([key, targets]): readonly [string, string] => [key, resolve(harnessRoot, targets[0]!)])
    .sort(([left], [right]) => right.length - left.length)
  return {
    name: 'dsh-harness-source-paths',
    enforce: 'pre',
    async resolveId(source: string, importer: string | undefined, options) {
      if (!source.startsWith('@deepseek-ai/')) return null
      for (const [key, target] of entries) {
        if (source !== key && !source.startsWith(`${key}/`)) continue
        const suffix = source === key ? '' : source.slice(key.length)
        const stripped = suffix.replace(/^\/src(?=\/)/u, '')
        // Deep `pkg/src/...` subpaths resolve against the package root, which
        // the paths map sometimes spells as the `src` directory and sometimes
        // as the `src/index.ts` entry file; try both spellings, then fall
        // through to default resolution — npm `./src/*` exports legitimately
        // answer the leftovers.
        const pkgRoot = target.endsWith('/src/index.ts') ? target.slice(0, -'/src/index.ts'.length) : target
        for (const candidate of new Set([target + suffix, target + stripped, pkgRoot + suffix, pkgRoot + stripped])) {
          const resolved = await this.resolve(candidate, importer, { ...options, skipSelf: true })
          if (resolved !== null) return resolved
        }
        return null
      }
      return null
    },
  }
}

const harnessPaths = harnessPathsPlugin()

// Harness-source modules resolve their own react copy from the harness tree
// while the standalone react-dom and @testing-library use this repository's —
// two instances break hook identity. Pin every react import to one copy.
const localRequire = createRequire(import.meta.url)
const singleReact = [
  { find: 'react', replacement: dirname(localRequire.resolve('react/package.json')) },
  { find: 'react-dom', replacement: dirname(localRequire.resolve('react-dom/package.json')) },
  // The harness renderer's store hook is a CJS dep that resolves its own react
  // peer outside Vite; a standalone copy whose peer is the standalone react
  // keeps hook identity with react-dom in one line with the aliases above.
  { find: 'use-sync-external-store', replacement: dirname(localRequire.resolve('use-sync-external-store/package.json')) },
]

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'node',
          include: ['packages/prompt-optimizer/tests/**/*.spec.ts', 'packages/api-prompt-optimizer/tests/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [
          ...(harnessPaths === undefined ? [] : [harnessPaths]),
          standardDecoratorPlugin(),
        ],
        test: {
          name: 'client',
          include: ['packages/client-ui-prompt-optimizer/tests/**/*.spec.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['vitest.setup.ts'],
        },
        resolve: { alias: singleReact },
      },
    ],
  },
})
