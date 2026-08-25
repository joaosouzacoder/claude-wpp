import { spawn } from 'node:child_process'

export function runClaude({
  bin = 'claude',
  cwd,
  prompt,
  sessionId = null,
  slowNoticeMs = 8000,
  timeoutMs = 900000,
  onSlow,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions']
    if (sessionId) args.push('--resume', sessionId)

    let finalizado = false
    let motivo = null
    let out = ''
    let err = ''

    // detached gives the child its own process group. claude spawns children
    // (Bash, subagents); killing only the parent leaves orphaned grandchildren
    // holding stdout open, and the close event never fires. Kill the group.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

    const matarGrupo = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }

    const encerrar = (resultado) => {
      if (finalizado) return
      finalizado = true
      clearTimeout(timerLento)
      clearTimeout(timerLimite)
      signal?.removeEventListener('abort', aoAbortar)
      resolve(resultado)
    }

    const timerLento = setTimeout(() => {
      if (!finalizado) onSlow?.()
    }, slowNoticeMs)

    const timerLimite = setTimeout(() => {
      motivo = 'timeout'
      matarGrupo()
    }, timeoutMs)

    const aoAbortar = () => {
      motivo = 'abort'
      matarGrupo()
    }
    signal?.addEventListener('abort', aoAbortar, { once: true })

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    child.on('error', (e) => encerrar({ ok: false, text: '', sessionId, error: e.message }))

    child.on('close', (code) => {
      if (motivo === 'timeout') {
        return encerrar({
          ok: false,
          text: '',
          sessionId,
          error: `Passei do tempo limite (${Math.round(timeoutMs / 1000)}s) e cancelei.`,
        })
      }
      if (motivo === 'abort') {
        return encerrar({ ok: false, text: '', sessionId, error: 'Interrompido.' })
      }

      let json
      try {
        json = JSON.parse(out)
      } catch {
        const detalhe = (err || out).trim().slice(0, 500)
        return encerrar({
          ok: false,
          text: '',
          sessionId,
          error: `Não entendi a resposta do claude (exit ${code}): ${detalhe || 'saída vazia'}`,
        })
      }

      const novoId = json.session_id ?? sessionId
      if (json.is_error) {
        return encerrar({ ok: false, text: '', sessionId: novoId, error: String(json.result ?? 'erro sem descrição') })
      }
      encerrar({ ok: true, text: String(json.result ?? ''), sessionId: novoId, error: null })
    })
  })
}
