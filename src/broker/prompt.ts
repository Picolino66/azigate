import type { BrokerExecuteRequest } from './protocol.js'

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

export function canonicalPrompt(request: BrokerExecuteRequest): string {
  return [
    'Você é um mecanismo stateless de decisão para um cliente OpenAI Compatible.',
    'Não leia arquivos, não execute comandos, não use ferramentas locais, MCP, browser, apps ou outros agentes.',
    'O Qwen Code remoto é o único executor. Você só pode responder com texto ou selecionar function tools oferecidas abaixo.',
    'Nunca invente nomes de ferramentas. arguments deve ser uma string contendo um objeto JSON válido.',
    'Se escolher texto, use content string e tool_calls vazio. Se escolher ferramentas, use content null.',
    'Obedeça tool_choice e parallel_tool_calls. Não inclua Markdown fora do objeto exigido pelo schema.',
    '',
    '<conversation_json>',
    JSON.stringify({
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.toolChoice,
      parallel_tool_calls: request.parallelToolCalls,
    }),
    '</conversation_json>',
  ].join('\n')
}
