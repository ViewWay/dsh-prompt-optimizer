/**
 * Standalone client-bundle preset for dsh web plugins, distilling the harness
 * `packages/client/tsdown.client.ts` contract: the bundle registers itself
 * through `window.__ModuleLoader__.load({id, factory})`, resolves externals
 * through the injected `require` (loader module table), and compiles CSS
 * modules with lightningcss into a plugin-owned style tag.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { defineConfig, type TsdownPlugin, type UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Browser-kernel module table shared with the harness web client. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Compile one `.module.css` import into a style-injection module exporting its
 * class map. Imports are rewritten to virtual ids that do not end in `.css`,
 * keeping them away from tsdown's built-in css pipeline (which would require
 * `@tsdown/css`).
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const cssModules: TsdownPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId, 'utf8')
    const { code, exports } = transform({
      code: Buffer.from(source),
      filename: fileId,
      // Hash-namespaced classes stay collision-free when another plugin ships
      // a module css with the same file basename.
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, entry] of Object.entries(exports ?? {})) classMap[local] = entry.name
    const tagId = fileId
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

/**
 * Bundle one plugin's browser entry as a closure-factory artifact.
 * @param id - exact package id the loader registers.
 * @param manifest - the plugin package.json, read for `dsh.client.external`.
 * @returns the tsdown user config for the client bundle.
 */
export function clientBundle(id: string, manifest: { readonly dsh?: { readonly client?: { readonly external?: readonly string[] } } }): UserConfig {
  const requested = new Set([...PLATFORM_MODULES, ...(manifest.dsh?.client?.external ?? [])])
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: { sourcemap: false },
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => requested.has(specifier),
      alwaysBundle: (specifier: string) => !requested.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssModules],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: () => `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default defineConfig
