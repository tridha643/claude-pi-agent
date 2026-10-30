import type { Register } from 'claude-code'

const MODEL = 'openai/gpt-6-astra'

// turnId -> the pi agent's id and the prompt its turn started with
const runs = new Map<string, { agentId: string; text: string }>()

type PiEvent = {
  type: string
  assistantMessageEvent?: { type: string; delta?: string }
  toolName?: string
  args?: Record<string, unknown>
  result?: { content?: { type: string; text?: string }[] }
  isError?: boolean
  message?: { stopReason?: string; errorMessage?: string }
}

const oneLine = (s: string, max: number) => {
  const line = s.trim().split('\n')[0].replaceAll('`', "'")
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// `afterTool`: the last thing rendered was a tool line, so text after it opens a new paragraph
const render = (ev: PiEvent, afterTool: boolean, isFirst: boolean): string => {
  switch (ev.type) {
    case 'message_update': {
      const delta = ev.assistantMessageEvent?.type === 'text_delta' ? (ev.assistantMessageEvent.delta ?? '') : ''
      return delta && afterTool ? `\n${delta}` : delta
    }
    case 'tool_execution_start': {
      const a = ev.args ?? {}
      const target = a.command ?? a.path ?? a.file_path ?? JSON.stringify(a)
      return `${isFirst || afterTool ? '' : '\n\n'}- **${ev.toolName}** \`${oneLine(String(target), 160)}\``
    }
    case 'tool_execution_end': {
      const out = ev.result?.content?.map(c => c.text ?? '').join('') ?? ''
      const shown = oneLine(out, 100)
      return `${ev.isError ? ' ✗' : ' →'} ${shown ? `\`${shown}\`` : '(no output)'}\n`
    }
    case 'turn_end':
      return ev.message?.stopReason === 'error' ? `\n\npi error: ${ev.message.errorMessage}\n` : ''
    default:
      return ''
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'pi',
      description: `Delegates a coding task to the pi agent running ${MODEL}. pi uses its own read/bash/edit/write tools in the session's directory, without Claude Code's permission prompts. Give it a self-contained task.`,
      prompt: 'Your replies are produced by the pi agent through the pi-agent mod.',
      // [] reads as "every tool" and zero tools is refused, so it lists one read-only tool
      tools: ['Read'],
      // no Claude model: turn.step answers every request, and a skipped hook errors instead of running a fallback
      model: `pi/${MODEL.split('/').pop()}`,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agent = (await $.agent.list()).find(a => a.id === e.agentId)
      if (agent?.type === `${$.plugin.name}:pi`) runs.set(e.turnId, { agentId: e.agentId, text: e.text })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const run = runs.get(e.turnId)
    if (run === undefined) return yield* next(e)
    runs.delete(e.turnId)

    const pi = $.process.spawn({
      argv: ['pi', '-p', '--mode', 'json', '--model', MODEL, '--session-id', run.agentId],
      // on stdin, so a prompt starting with @ isn't read as a file
      input: run.text,
    })
    let answer = ''
    let afterTool = false
    let pending = ''
    let stderr = ''
    const piece = (line: string) => {
      let ev: PiEvent
      try {
        ev = JSON.parse(line)
      } catch {
        return ''
      }
      const text = render(ev, afterTool, answer === '')
      if (text !== '') {
        answer += text
        afterTool = ev.type === 'tool_execution_end'
      }
      return text
    }
    for await (const chunk of pi) {
      if (next.signal.aborted) break
      if (chunk.stream === 'stderr') {
        stderr += chunk.text
        continue
      }
      pending += chunk.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const text = piece(line)
        if (text !== '') yield { kind: 'text', index: 0, text }
      }
    }
    if (next.signal.aborted) return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: null, usage: null }
    const last = piece(pending)
    if (last !== '') yield { kind: 'text', index: 0, text: last }
    if (answer.trim() === '') {
      const text = `pi produced no output.${stderr ? `\n\n\`\`\`\n${stderr.slice(-2000)}\n\`\`\`` : ''}`
      answer = text
      yield { kind: 'text', index: 0, text }
    }

    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
}
