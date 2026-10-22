// 測試輔助：起子程序並保證收乾淨。
// - Windows 上 child.kill() 只殺那一個程序（TerminateProcess），橋底下的假 claude 工作者會變孤兒、拖住 node --test 不結束；
//   這裡把 kill() 換成「只殺自己這棵樹」（taskkill /T /F /PID <自己記下的 PID>），不做任何整批殺。
// - 測試丟例外、逾時沒走到 child.kill() 時，測試程序結束前（exit 事件）再掃一次還活著的子程序。
import { spawn, spawnSync } from 'node:child_process'

const live = new Set()

function killTreeSync(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

export function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, opts)
  live.add(child)
  child.once('exit', () => live.delete(child))
  const plainKill = child.kill.bind(child)
  child.kill = (sig) => {
    if (process.platform !== 'win32') return plainKill(sig)
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false
    killTreeSync(child.pid)
    return true
  }
  return child
}

process.on('exit', () => {
  for (const c of live) if (c.pid && c.exitCode === null && c.signalCode === null) killTreeSync(c.pid)
})
