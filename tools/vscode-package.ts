import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Extensão VS Code da máquina B (ADR-028): um bundle CommonJS com o painel de agentes e o
// controle do Workspace Server. Nada do Model Plane nem do agentd entra no pacote.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'src/vscode-extension/extension.ts'
export const VSCODE_ENGINE = '^1.100.0'
export const EXTENSION_NAME = 'azigate-vscode'
export const EXTENSION_PUBLISHER = 'azigate'

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
<path d="M4 18 12 4l8 14"/><path d="M7.5 12.5h9"/><circle cx="12" cy="18" r="1.6"/>
</svg>
`

const README = `# Azigate para VS Code

Painel de agentes do Native Agent Plane do azigate na máquina do projeto (B).

- Converse com **Claude Code**, **Codex** ou **AGY**, que rodam no \`azigate-agentd\` (máquina A)
  e operam este projeto pelo Workspace Server, sem copiar nada para A.
- Aprove ou negue cada ação pedida pelo agente: só o botão **Permitir** aprova.
- Inicie e pare o \`azigate-workspace\` local direto do painel.

## Pré-requisitos

1. Pacote \`azigate-client\` instalado na máquina B (\`npm install -g azigate-client-*.tgz\`).
2. Bloco do \`npm run -s client:setup\` colado na B (cria \`~/.config/azigate\`).
3. Chave do agentd: \`agent.key\` (0600) do \`client:setup --with-agent-key\` ou o comando
   **Azigate: Definir chave do agentd**, que a guarda no armazenamento seguro do VS Code.

## Configurações (somente nas configurações de usuário)

| Configuração | Padrão | Uso |
|---|---|---|
| \`azigate.agentUrl\` | vazio | URL do agentd; vazio usa \`AZIGATE_AGENT_URL\` → \`agent.json\` → \`http://127.0.0.1:3100\` |
| \`azigate.defaultProvider\` | \`claude\` | agente selecionado ao abrir |
| \`azigate.workspaceServer.command\` | \`azigate-workspace\` | programa do Workspace Server (nome ou caminho absoluto) |
| \`azigate.workspaceServer.autoStart\` | \`false\` | inicia o Workspace Server ao ativar a extensão |
`

export function extensionManifest(version: string): Record<string, unknown> {
  const machine = 'machine'
  return {
    name: EXTENSION_NAME,
    displayName: 'Azigate',
    description: 'Claude Code, Codex e AGY do azigate-agentd operando este projeto pelo Workspace Server',
    version,
    publisher: EXTENSION_PUBLISHER,
    private: true,
    license: 'UNLICENSED',
    engines: { vscode: VSCODE_ENGINE },
    categories: ['Other'],
    main: './dist/extension.cjs',
    // Roda onde está o projeto (inclusive em Remote-SSH), que é onde o Workspace Server precisa rodar.
    extensionKind: ['workspace'],
    activationEvents: ['onView:azigate.chat'],
    capabilities: {
      untrustedWorkspaces: { supported: false, description: 'A extensão inicia o Workspace Server local.' },
      virtualWorkspaces: false,
    },
    contributes: {
      viewsContainers: { activitybar: [{ id: 'azigate', title: 'Azigate', icon: 'resources/azigate.svg' }] },
      views: { azigate: [{ type: 'webview', id: 'azigate.chat', name: 'Agentes' }] },
      commands: [
        { command: 'azigate.setAgentKey', title: 'Definir chave do agentd', category: 'Azigate' },
        { command: 'azigate.clearAgentKey', title: 'Remover chave do agentd', category: 'Azigate' },
        { command: 'azigate.startWorkspaceServer', title: 'Iniciar Workspace Server', category: 'Azigate' },
        { command: 'azigate.stopWorkspaceServer', title: 'Parar Workspace Server', category: 'Azigate' },
        { command: 'azigate.newSession', title: 'Nova sessão', category: 'Azigate' },
        { command: 'azigate.showLog', title: 'Mostrar log', category: 'Azigate' },
      ],
      configuration: {
        title: 'Azigate',
        properties: {
          'azigate.agentUrl': {
            type: 'string',
            default: '',
            scope: machine,
            markdownDescription: 'URL do `azigate-agentd` (`https://`; `http://` só em loopback). Vazio usa `AZIGATE_AGENT_URL`, `agent.json` ou `http://127.0.0.1:3100`.',
          },
          'azigate.defaultProvider': {
            type: 'string',
            enum: ['claude', 'codex', 'agy'],
            enumDescriptions: ['Claude Code', 'Codex', 'Google Antigravity (AGY)'],
            default: 'claude',
            scope: machine,
            description: 'Agente selecionado ao abrir o painel.',
          },
          'azigate.workspaceServer.command': {
            type: 'string',
            default: 'azigate-workspace',
            scope: machine,
            description: 'Programa do Workspace Server: nome no PATH ou caminho absoluto, sem argumentos.',
          },
          'azigate.workspaceServer.autoStart': {
            type: 'boolean',
            default: false,
            scope: machine,
            description: 'Inicia o Workspace Server ao ativar a extensão, quando existe workspace.json.',
          },
        },
      },
    },
  }
}

function vsixManifest(version: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${EXTENSION_NAME}" Version="${version}" Publisher="${EXTENSION_PUBLISHER}" />
    <DisplayName>Azigate</DisplayName>
    <Description xml:space="preserve">Claude Code, Codex e AGY do azigate-agentd operando este projeto pelo Workspace Server</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${VSCODE_ENGINE}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".cjs" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP sem compressão (método 0) e com data fixa, para o `.vsix` sair reprodutível. */
export function createZip(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Buffer {
  const DOS_TIME = 0
  const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 01/01/1980
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Gera `<outDir>/extension` (pasta instalável) e devolve os arquivos do pacote. */
export async function buildVscodeExtension(outDir: string): Promise<{ dir: string; files: Map<string, Buffer>; version: string }> {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const version = rootPackage.version
  const dir = join(outDir, 'extension')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'resources'), { recursive: true })
  const result = await build({
    entryPoints: [join(ROOT, ENTRY)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    write: false,
    logLevel: 'silent',
  })
  const bundle = result.outputFiles[0]
  if (!bundle) throw new Error('esbuild não gerou o bundle da extensão')
  const files = new Map<string, Buffer>([
    ['package.json', Buffer.from(`${JSON.stringify(extensionManifest(version), null, 2)}\n`)],
    ['README.md', Buffer.from(README)],
    ['dist/extension.cjs', Buffer.from(bundle.contents)],
    ['resources/azigate.svg', Buffer.from(ICON)],
  ])
  for (const [name, data] of files) writeFileSync(join(dir, name), data)
  return { dir, files, version }
}

/** Empacota em `<outDir>/azigate-vscode-<versão>.vsix` ("Install from VSIX…" no VS Code). */
export async function packVscodeExtension(outDir: string): Promise<string> {
  const { files, version } = await buildVscodeExtension(outDir)
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(version)) },
    ...[...files].map(([name, data]) => ({ name: `extension/${name}`, data })),
  ]
  const file = join(outDir, `${EXTENSION_NAME}-${version}.vsix`)
  writeFileSync(file, createZip(entries))
  return file
}
