# ADR-006 — Agente cliente como único executor

- Status: aceito
- Fase: reavaliação F2/F3
- Data: 16/07/2026

## Contexto

Os repositórios e o VS Code ficam no computador do agente cliente (no caso do autor, acessado na LAN via VPN; mas pode ser qualquer máquina). Se Codex ou Claude executassem ferramentas no servidor do gateway, poderiam alterar a máquina errada e expor credenciais ou arquivos administrativos.

## Opções consideradas

- Compartilhar o repositório remoto com o broker: permitiria edição direta, mas violaria a separação entre decisão e execução.
- Converter texto do CLI em patch: reduziria dependência de tool calls, porém introduziria interpretação heurística e alterações sem contrato verificável.
- Fazer o CLI produzir uma decisão estruturada: preserva o tool loop OpenAI e deixa leitura, comandos e edições sob confirmação do agente.

## Decisão

O agente cliente é o único executor. O upstream, o Codex e o Claude apenas retornam texto ou tool calls. O broker executa cada CLI de forma efêmera em Bubblewrap, com `/work` e `/tmp` descartáveis, sem repositório ou home do operador, sem ferramentas locais e com argv fixo.

A saída final segue schema fechado. O gateway rejeita nomes de ferramentas não oferecidos, argumentos que não sejam JSON válido e qualquer evento de execução local. IDs de tool calls são sempre gerados pelo gateway. Texto nunca é interpretado como patch.

## Trade-offs e consequências

O histórico completo e os resultados de tools precisam voltar em cada requisição stateless. A qualidade depende da aderência do CLI ao schema e é comprovada por gate sintético; uma versão que não ofereça todos os controles mantém o alias indisponível.
