import { WorkerRpcError, type WorkerMethod } from '../worker-protocol/protocol.js'
import {
  deletePath,
  editFile,
  findFile,
  listDirectory,
  makeDirectory,
  readFile,
  search,
  writeFile,
} from './fs-ops.js'
import { gitDiff, gitLog, gitStatus } from './git-ops.js'
import { ProcessRegistry, shellExec, type ExecPolicy } from './process-ops.js'

type Params = Record<string, unknown>

/** Despacha um RPC do agentd para o workspace local correto. */
export class WorkerHandler {
  private readonly processes: ProcessRegistry

  constructor(
    private readonly workspaces: ReadonlyMap<string, string>,
    private readonly policy: ExecPolicy,
  ) {
    this.processes = new ProcessRegistry(policy)
  }

  get workspaceIds(): string[] {
    return [...this.workspaces.keys()]
  }

  get execEnabled(): boolean {
    return this.policy.enabled
  }

  async handle(workspace: string, method: WorkerMethod, params: Params): Promise<unknown> {
    const root = this.workspaces.get(workspace)
    if (!root) throw new WorkerRpcError('workspace_not_found', 'Workspace não configurado neste worker')
    switch (method) {
      case 'list_directory':
        return listDirectory(root, params)
      case 'find_file':
        return findFile(root, params)
      case 'search':
        return search(root, params)
      case 'read_file':
        return readFile(root, params)
      case 'write_file':
        return writeFile(root, params)
      case 'edit_file':
        return editFile(root, params)
      case 'mkdir':
        return makeDirectory(root, params)
      case 'delete':
        return deletePath(root, params)
      case 'git_status':
        return gitStatus(root)
      case 'git_diff':
        return gitDiff(root, params)
      case 'git_log':
        return gitLog(root, params)
      case 'shell_exec':
        return shellExec(root, params, this.policy)
      case 'process_start':
        return this.processes.start(root, params)
      case 'process_stdin':
        return this.processes.stdin(params)
      case 'process_output':
        return this.processes.output(params)
      case 'process_kill':
        return this.processes.kill(params)
    }
  }

  shutdown(): void {
    this.processes.killAll()
  }
}
