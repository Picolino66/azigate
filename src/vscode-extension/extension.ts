import * as vscode from 'vscode'
import { AgentApi } from '../agent-client/api.js'
import { loadLocalWorkspaces, resolveConnection, workspaceForFolders } from './connection.js'
import { isProviderId, parseInboundMessage, type OutboundMessage } from './protocol.js'
import { SessionController } from './session-controller.js'
import { createNonce, renderWebviewHtml } from './webview.js'
import { WorkspaceServerProcess } from './workspace-process.js'

const VIEW_ID = 'azigate.chat'
const SECRET_KEY = 'azigate.agentKey'

/**
 * Extensão Azigate para a máquina do projeto (B), ADR-028: painel de chat com Claude, Codex e
 * AGY rodando no agentd (máquina A) e controle do Workspace Server local. Mesmas regras do
 * `azigate-agent`: workspace só por ID, aprovação só com clique explícito em "Permitir".
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Azigate')
  let view: vscode.WebviewView | undefined
  const post = (message: OutboundMessage): void => {
    void view?.webview.postMessage(message)
  }

  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('azigate')
  const configuredProvider = config().get<string>('defaultProvider')

  const server = new WorkspaceServerProcess({
    onStatus: (status, detail) => {
      output.appendLine(`[workspace-server] ${status}${detail ? `: ${detail}` : ''}`)
      controller.setServerStatus(status, detail)
    },
    onLog: (line) => output.appendLine(`[workspace-server] ${line}`),
  })

  const controller: SessionController = new SessionController(
    {
      post,
      approvalRequested: (approvalId, label) => {
        if (view?.visible) return
        void vscode.window
          .showWarningMessage(`Azigate: o agente pede aprovação para ${label}`, 'Permitir', 'Negar', 'Abrir painel')
          .then((choice) => {
            if (choice === 'Permitir') return controller.decide(approvalId, 'allow')
            if (choice === 'Negar') return controller.decide(approvalId, 'deny')
            if (choice === 'Abrir painel') return vscode.commands.executeCommand(`${VIEW_ID}.focus`)
            // Fechar o aviso não decide nada: o card continua no painel e o agentd nega ao expirar.
            return undefined
          })
      },
      startServer: () => server.start(config().get<string>('workspaceServer.command')),
      stopServer: () => server.stop(),
    },
    isProviderId(configuredProvider) ? { provider: configuredProvider } : {},
  )

  const reloadWorkspaces = (): void => {
    try {
      const local = loadLocalWorkspaces()
      const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
      controller.setLocalWorkspaces([...local.workspaces.keys()], workspaceForFolders(local.workspaces, folders))
    } catch (error) {
      output.appendLine(`[config] ${error instanceof Error ? error.message : 'workspace.json inválido'}`)
      controller.setLocalWorkspaces([], undefined)
    }
  }

  const reconnect = async (): Promise<void> => {
    try {
      const connection = resolveConnection({
        urlOverride: config().get<string>('agentUrl'),
        secretKey: await context.secrets.get(SECRET_KEY),
      })
      output.appendLine(`[agentd] ${new URL(connection.url).host}`)
      await controller.setApi(new AgentApi(connection.url, connection.key))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'configuração inválida'
      output.appendLine(`[agentd] ${message}`)
      await controller.setApi(undefined, message)
    }
  }

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      {
        resolveWebviewView(webviewView) {
          view = webviewView
          webviewView.webview.options = { enableScripts: true, localResourceRoots: [] }
          webviewView.webview.html = renderWebviewHtml({ nonce: createNonce(), cspSource: webviewView.webview.cspSource })
          webviewView.webview.onDidReceiveMessage((raw: unknown) => {
            const message = parseInboundMessage(raw)
            if (message) void controller.handle(message)
          })
          webviewView.onDidDispose(() => {
            if (view === webviewView) view = undefined
          })
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('azigate.setAgentKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Chave do agentd (AGENT_API_KEYS)',
        prompt: 'Fica guardada no armazenamento seguro do VS Code, nunca nas configurações.',
        password: true,
        ignoreFocusOut: true,
      })
      if (!key?.trim()) return
      // `secrets.onDidChange` reconecta.
      await context.secrets.store(SECRET_KEY, key.trim())
    }),
    vscode.commands.registerCommand('azigate.clearAgentKey', async () => {
      await context.secrets.delete(SECRET_KEY)
    }),
    vscode.commands.registerCommand('azigate.startWorkspaceServer', () => server.start(config().get<string>('workspaceServer.command'))),
    vscode.commands.registerCommand('azigate.stopWorkspaceServer', () => server.stop()),
    vscode.commands.registerCommand('azigate.newSession', () => controller.handle({ type: 'newSession' })),
    vscode.commands.registerCommand('azigate.showLog', () => output.show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('azigate.agentUrl')) void reconnect()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reloadWorkspaces()),
    context.secrets.onDidChange((event) => {
      if (event.key === SECRET_KEY) void reconnect()
    }),
    { dispose: () => server.stop() },
  )

  reloadWorkspaces()
  void reconnect()
  if (config().get<boolean>('workspaceServer.autoStart') && loadLocalWorkspacesSafe()) {
    server.start(config().get<string>('workspaceServer.command'))
  }

  deactivateHook = async () => {
    server.stop()
    await controller.dispose()
  }
}

function loadLocalWorkspacesSafe(): boolean {
  try {
    return loadLocalWorkspaces().exists
  } catch {
    return false
  }
}

let deactivateHook: (() => Promise<void>) | undefined

export async function deactivate(): Promise<void> {
  await deactivateHook?.()
}
