# Empacotamento e instalação

## Descrição

Gera o `.vsix` da extensão na máquina A (onde está o repositório) para instalar no VS Code da
máquina B, sem publicar no Marketplace.

## Localização no código

`tools/vscode-package.ts` (`extensionManifest`, `createZip`, `crc32`,
`buildVscodeExtension`, `packVscodeExtension`) e `tools/build-vscode.ts` (entrypoint de
`npm run pack:vscode`).

## Entrada

`npm run pack:vscode [-- <pasta>]` (padrão `dist-vscode/`). A versão vem do `package.json` raiz.

## Saída

- `dist-vscode/extension/`: pasta da extensão (`package.json`, `README.md`,
  `dist/extension.cjs` e `resources/azigate.svg`);
- `dist-vscode/azigate-vscode-<versão>.vsix`.

## Dependências

esbuild (devDependency, só na máquina A) e `@types/vscode` 1.100.0 para o typecheck. Na máquina
B: VS Code `>=1.100` e o [`azigate-client`](../workspace/client-package.md).

## Regras de negócio

- Bundle CommonJS (`format: cjs`, `target: node20`) com `vscode` externo. Só código da máquina B
  entra no bundle. Um teste de regressão confere que o bundle não contém código do Model Plane nem
  do agentd.
- O `.vsix` é um ZIP sem compressão e com data fixa (reprodutível), com
  `extension.vsixmanifest` e `[Content_Types].xml`.
- Manifesto: `publisher: azigate`, `private: true`, `engines.vscode: ^1.100.0`,
  `extensionKind: ["workspace"]` (em Remote-SSH roda no host do projeto),
  `untrustedWorkspaces.supported: false`, ativação por `onView:azigate.chat` e configurações
  `azigate.*` com escopo `machine`.
- `dist-vscode/` é artefato gerado (no `.gitignore` e ignorado pelo ESLint).

## Fluxo resumido

Máquina A: `npm run pack:vscode` → copia o `.vsix` para a B → VS Code da B: **Extensions → … →
Install from VSIX…** (ou `code --install-extension azigate-vscode-<versão>.vsix`) → **Azigate:
Definir chave do agentd**, se não houver `agent.key` → abre o painel **Azigate** → **Iniciar**
o Workspace Server → conversa.

## Possíveis erros

`pack:vscode: esbuild não gerou o bundle da extensão` e erros de compilação do esbuild. No VS
Code: versão anterior a 1.100 recusa a instalação pelo `engines`, e em modo restrito a
extensão fica desativada até o workspace ser marcado como confiável.
