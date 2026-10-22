import manifest from './package.json' with { type: 'json' }
import { defineConfig } from 'tsdown'
import { clientBundle } from '../../tools/tsdown.client.ts'

export default defineConfig([
  { name: 'host', entry: { host: 'src/index.ts' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: { sourcemap: false } },
  clientBundle(manifest.name, manifest),
])
