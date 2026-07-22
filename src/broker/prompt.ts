import type { BrokerExecuteRequest, BrokerToolChoice } from './protocol.js'

export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'tool_calls'],
  properties: {
    content: { type: ['string', 'null'] },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          arguments: { type: 'string' },
        },
      },
    },
  },
} as const

function allowedToolNames(request: Pick<BrokerExecuteRequest, 'tools' | 'toolChoice'>): string[] {
  const names = request.tools.map((tool) => tool.name)
  return typeof request.toolChoice === 'object' ? [request.toolChoice.name] : names
}

function allowsText(choice: BrokerToolChoice): boolean {
  return choice !== 'required' && typeof choice !== 'object'
}

function allowsTools(choice: BrokerToolChoice): boolean {
  return choice !== 'none'
}

export function decisionJsonSchema(
  request: Pick<BrokerExecuteRequest, 'tools' | 'toolChoice' | 'parallelToolCalls'>,
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = []
  if (allowsText(request.toolChoice)) {
    branches.push({
      type: 'object',
      additionalProperties: false,
      required: ['content', 'tool_calls'],
      properties: {
        content: { type: 'string' },
        tool_calls: { type: 'array', maxItems: 0 },
      },
    })
  }
  const names = allowedToolNames(request)
  if (allowsTools(request.toolChoice) && names.length > 0) {
    branches.push({
      type: 'object',
      additionalProperties: false,
      required: ['content', 'tool_calls'],
      properties: {
        content: { type: 'null' },
        tool_calls: {
          type: 'array',
          minItems: 1,
          ...(request.parallelToolCalls ? {} : { maxItems: 1 }),
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', enum: names },
              arguments: { type: 'string' },
            },
          },
        },
      },
    })
  }
  return branches.length === 1 ? branches[0] ?? DECISION_JSON_SCHEMA : { oneOf: branches }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function canonicalSystemPrompt(request: Pick<BrokerExecuteRequest, 'tools'>): string {
  return [
    'Você é um mecanismo de decisão para um cliente OpenAI Compatible.',
    'Não leia arquivos, não execute comandos, não use ferramentas locais, MCP, browser, apps ou outros agentes.',
    'O Qwen Code remoto é o único executor. Você só pode responder com texto ou selecionar function tools oferecidas abaixo.',
    'Seu ambiente local é uma sandbox descartável sem relação com o computador do usuário.',
    'Ignore o estado dessa sandbox: modo somente leitura, política de aprovação ou falta de permissão local nunca justificam recusa.',
    'Para criar, editar ou apagar arquivos, ou executar comandos, selecione a function tool correspondente; o executor remoto aplica a ação na máquina dele.',
    'Nunca invente nomes de ferramentas. arguments deve ser uma string contendo um objeto JSON válido.',
    'Se escolher texto, use content string e tool_calls vazio. Se escolher ferramentas, use content null.',
    'Obedeça tool_choice e parallel_tool_calls. Não inclua Markdown fora do objeto exigido pelo schema.',
    '<tools_json>',
    stableJson([...request.tools].sort((left, right) => left.name.localeCompare(right.name))),
    '</tools_json>',
  ].join('\n')
}

export function canonicalTurnPrompt(
  request: Pick<BrokerExecuteRequest, 'messages' | 'toolChoice' | 'parallelToolCalls'>,
): string {
  return [
    '<turn_json>',
    stableJson({
      messages: request.messages,
      tool_choice: request.toolChoice,
      parallel_tool_calls: request.parallelToolCalls,
    }),
    '</turn_json>',
  ].join('\n')
}

export function canonicalPrompt(request: BrokerExecuteRequest): string {
  return `${canonicalSystemPrompt(request)}\n\n${canonicalTurnPrompt(request)}`
}
