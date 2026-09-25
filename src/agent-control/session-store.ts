import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { AgentProviderId, PermissionMode } from '../agents/core/agent-provider.js'

export const SESSION_STATUSES = ['starting', 'ready', 'running', 'suspended', 'failed', 'closed'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** Somente metadados (ADR-024). Nenhum campo guarda prompt, resposta, ferramenta ou segredo. */
export interface SessionRecord {
  id: string
  provider: AgentProviderId
  nativeSessionId: string | null
  workerId: string | null
  workspaceId: string
  status: SessionStatus
  model: string | null
  effort: string | null
  permissionMode: PermissionMode
  ownerCredentialId: string
  providerVersion: string | null
  adapterVersion: string
  protocolVersion: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type SessionPatch = Partial<Pick<SessionRecord, 'nativeSessionId' | 'status' | 'model' | 'closedAt'>>

export interface SessionStore {
  insert(record: SessionRecord): void
  update(id: string, patch: SessionPatch, updatedAt: string): SessionRecord | undefined
  get(id: string): SessionRecord | undefined
  /** Marca como `suspended` (com sessão nativa) ou `failed` o que estava ativo antes do reinício. */
  recoverAfterRestart(updatedAt: string): { suspended: number; failed: number }
  healthy(): boolean
  close(): void
}

export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>()

  insert(record: SessionRecord): void {
    if (this.records.has(record.id)) throw new Error('Sessão duplicada')
    this.records.set(record.id, { ...record })
  }

  update(id: string, patch: SessionPatch, updatedAt: string): SessionRecord | undefined {
    const current = this.records.get(id)
    if (!current) return undefined
    const next = { ...current, ...patch, updatedAt }
    this.records.set(id, next)
    return { ...next }
  }

  get(id: string): SessionRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  recoverAfterRestart(updatedAt: string): { suspended: number; failed: number } {
    let suspended = 0
    let failed = 0
    for (const record of this.records.values()) {
      if (!['starting', 'ready', 'running'].includes(record.status)) continue
      if (record.nativeSessionId) {
        record.status = 'suspended'
        suspended += 1
      } else {
        record.status = 'failed'
        failed += 1
      }
      record.updatedAt = updatedAt
    }
    return { suspended, failed }
  }

  healthy(): boolean {
    return true
  }

  close(): void {
    this.records.clear()
  }
}

interface SessionRow {
  id: string
  provider: string
  native_session_id: string | null
  worker_id: string | null
  workspace_id: string
  status: string
  model: string | null
  effort: string | null
  permission_mode: string
  owner_credential_id: string
  provider_version: string | null
  adapter_version: string
  protocol_version: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

function fromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    provider: row.provider as AgentProviderId,
    nativeSessionId: row.native_session_id,
    workerId: row.worker_id,
    workspaceId: row.workspace_id,
    status: row.status as SessionStatus,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode as PermissionMode,
    ownerCredentialId: row.owner_credential_id,
    providerVersion: row.provider_version,
    adapterVersion: row.adapter_version,
    protocolVersion: row.protocol_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  native_session_id TEXT,
  worker_id TEXT,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  permission_mode TEXT NOT NULL,
  owner_credential_id TEXT NOT NULL,
  provider_version TEXT,
  adapter_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_status ON sessions (status);
`

const PATCH_COLUMNS: Readonly<Record<keyof SessionPatch, string>> = {
  nativeSessionId: 'native_session_id',
  status: 'status',
  model: 'model',
  closedAt: 'closed_at',
}

/** `SessionStore` em SQLite embutido do Node (`node:sqlite`). Arquivo `0600`, diretório `0700`. */
export class SqliteSessionStore implements SessionStore {
  private constructor(private readonly db: DatabaseSyncType) {}

  static async open(path: string): Promise<SqliteSessionStore> {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Cria o arquivo já com 0600 para o SQLite herdar a permissão nos arquivos WAL/SHM.
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600, flag: 'a' })
    chmodSync(path, 0o600)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    db.exec(SCHEMA)
    return new SqliteSessionStore(db)
  }

  insert(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, provider, native_session_id, worker_id, workspace_id, status, model, effort,
          permission_mode, owner_credential_id, provider_version, adapter_version, protocol_version, created_at,
          updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.provider,
        record.nativeSessionId,
        record.workerId,
        record.workspaceId,
        record.status,
        record.model,
        record.effort,
        record.permissionMode,
        record.ownerCredentialId,
        record.providerVersion,
        record.adapterVersion,
        record.protocolVersion,
        record.createdAt,
        record.updatedAt,
        record.closedAt,
      )
  }

  update(id: string, patch: SessionPatch, updatedAt: string): SessionRecord | undefined {
    const assignments: string[] = ['updated_at = ?']
    const values: (string | null)[] = [updatedAt]
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof SessionPatch, string][]) {
      if (!(key in patch)) continue
      assignments.push(`${column} = ?`)
      values.push(patch[key] ?? null)
    }
    this.db.prepare(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
    return this.get(id)
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? fromRow(row) : undefined
  }

  recoverAfterRestart(updatedAt: string): { suspended: number; failed: number } {
    const active = "status IN ('starting', 'ready', 'running')"
    const suspended = this.db
      .prepare(`UPDATE sessions SET status = 'suspended', updated_at = ? WHERE ${active} AND native_session_id IS NOT NULL`)
      .run(updatedAt).changes
    const failed = this.db
      .prepare(`UPDATE sessions SET status = 'failed', updated_at = ? WHERE ${active} AND native_session_id IS NULL`)
      .run(updatedAt).changes
    return { suspended: Number(suspended), failed: Number(failed) }
  }

  healthy(): boolean {
    try {
      this.db.prepare('SELECT 1').get()
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.db.close()
  }
}
