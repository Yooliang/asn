// 檔案小工具：原子寫入、附加一行並 fsync、讀 jsonl、單一執行個體 pid 檔。純 Node、無依賴。
import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  try { fs.chmodSync(dir, mode) } catch {}   // mkdir 的 mode 會被 umask 吃掉，也不會改已存在的資料夾
}

// 先寫同目錄暫存檔、fsync、再 rename：中途斷電／被殺不會留下半個檔
export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', mode)
  try { fs.writeSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.chmodSync(tmp, mode) } catch {}
  fs.renameSync(tmp, file)
}

// 附加一行並 fsync，回傳才算「已寫入磁碟」。上次若在寫到一半時被殺（檔尾沒有換行），先補一個換行，不讓兩封信黏成一行。
export function appendLineDurable(file, line, mode = 0o600) {
  const fd = fs.openSync(file, 'a+', mode)
  try {
    const size = fs.fstatSync(fd).size
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      fs.readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 0x0a) prefix = '\n'
    }
    fs.writeSync(fd, prefix + line + '\n')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

// 讀 jsonl：檔不存在回 []；壞行（例如半行）略過
export function readJsonl(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// 單一執行個體。pid 檔會跨重置保留，新容器裡同一個數字可能是別的程序，
// 所以有 /proc 時還要確認那個 pid 的命令列真的是我們（含 match），不然視為過期的 pid 檔。
export function isOurProcess(pid, match, procRoot = '/proc') {
  try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return false }
  try { return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').includes(match) } catch { return true }   // 沒有 /proc（Windows／macOS）就只看活不活
}

// 拿到鎖回 true；已有另一個活著的執行個體回 false
export function acquirePidLock(pidFile, match, procRoot) {
  try {
    const old = Number(fs.readFileSync(pidFile, 'utf8'))
    if (old && old !== process.pid && isOurProcess(old, match, procRoot)) return false
  } catch {}
  writeFileAtomic(pidFile, String(process.pid), 0o600)
  process.on('exit', () => { try { if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.unlinkSync(pidFile) } catch {} })
  return true
}
