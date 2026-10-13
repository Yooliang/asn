// 重現 2026-10-13 的事故：主控台寫不出去（寫入時非同步發出 'error'，像 EPIPE），uncaughtException 處理器又去記錄。
// 用法：node fake-log-loop.mjs <naive|safe> <記錄檔>
//   naive：舊的寫法（寫主控台＋寫檔），會進無限迴圈、記錄檔一直長。
//   safe：safe-log.mjs 的 createLog，記一次就停。
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { createLog } from '../safe-log.mjs'

const [mode, file] = process.argv.slice(2)
// 壞掉的主控台：跟 process.stderr 一樣不會被「關掉」，每次寫都在下一輪發出 'error'（EPIPE）；沒人聽 'error' 就是 uncaughtException
class BrokenStderr extends EventEmitter {
  write() { const e = new Error('write EPIPE'); e.code = 'EPIPE'; process.nextTick(() => this.emit('error', e)); return false }
}
const broken = new BrokenStderr()

const log = mode === 'naive'
  ? msg => { const line = `${new Date().toISOString()} ${msg}`; broken.write(line + '\n'); try { fs.appendFileSync(file, line + '\n') } catch {} }
  : createLog(file, { stderr: broken })

process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
log('bridge started')
setTimeout(() => process.exit(0), 1500)
