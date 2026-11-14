import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Pacote da máquina B (azigate-client): só o Workspace Server e o azigate-agent, cada um num
// arquivo único sem dependências (o `ws` vai embutido). Nada do Model Plane nem do agentd.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CLIENT_BINS = {
  'azigate-workspace': 'src/workspace/server/main.ts',
  'azigate-agent': 'src/agent-client/main.ts',
} as const

// O `ws` é CommonJS e usa `require` de módulos nativos; num bundle ESM isso exige um `require` real.
const BANNER = "import { createRequire as __azigateRequire } from 'node:module';\nconst require = __azigateRequire(import.meta.url);"

const README = `# azigate-client

Programas da máquina do projeto (B) do Native Agent Plane do azigate:

- \`azigate-workspace\`: dá aos agentes da máquina A (Claude Code, Codex, AGY) acesso a este
  projeto por MCP. Não chama modelo e não copia o projeto.
- \`azigate-agent\`: conversa com esses agentes (\`azigate-agent chat claude meu-projeto\`).

Configure com o bloco gerado na máquina A por \`npm run -s client:setup\` e rode:

    azigate-workspace
    azigate-agent chat claude meu-projeto
`

/** Gera `<outDir>/package` com package.json, README e os binários empacotados. */
export async function buildClientPackage(outDir: string): Promise<string> {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } }
  const packageDir = join(outDir, 'package')
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(join(packageDir, 'bin'), { recursive: true })
  for (const [name, entry] of Object.entries(CLIENT_BINS)) {
    const outfile = join(packageDir, 'bin', `${name}.mjs`)
    await build({
      entryPoints: [join(ROOT, entry)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      banner: { js: BANNER },
      // Aceleradores opcionais do `ws`; ele segue sem eles.
      external: ['bufferutil', 'utf-8-validate'],
      logLevel: 'silent',
    })
    chmodSync(outfile, 0o755)
  }
  const manifest = {
    name: 'azigate-client',
    version: rootPackage.version,
    private: true,
    description: 'Workspace Server e cliente de terminal do Native Agent Plane do azigate (máquina do projeto)',
    type: 'module',
    license: 'UNLICENSED',
    bin: Object.fromEntries(Object.keys(CLIENT_BINS).map((name) => [name, `bin/${name}.mjs`])),
    files: ['bin', 'README.md'],
    engines: { node: rootPackage.engines?.node ?? '>=20.18.1' },
  }
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(packageDir, 'README.md'), README)
  return packageDir
}

/** Empacota em `<outDir>/azigate-client-<versão>.tgz`, instalável com `npm install -g`. */
export async function packClient(outDir: string): Promise<string> {
  const packageDir = await buildClientPackage(outDir)
  const name = execFileSync('npm', ['pack', packageDir, '--pack-destination', outDir, '--silent'], { encoding: 'utf8' }).trim()
  return join(outDir, name.split('\n').pop() ?? name)
}
