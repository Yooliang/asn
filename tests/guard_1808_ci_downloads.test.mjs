// #1808 第 18 組守門：CI 外部下載逾時／被限流（#1622、#1627、#1796）。
// 只讀 workflow 與腳本文字，不連網、不跑 apt／gradle。每一條對應一個已修好的問題；拿掉修法就要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const WF = rd('.github/workflows/asn-linux-build.yml')
const APT = rd('.github/scripts/apt-install.sh')

// 取一個 job 的文字（兩格縮排的 key 到下一個兩格縮排的 key）
const job = name => {
  const m = WF.match(new RegExp(String.raw`^  ${name}:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))`, 'm'))
  assert.ok(m, `找不到 job ${name}`)
  return m[1]
}
// 把 job 切成 steps（六格縮排的 "- "）
const steps = text => text.split(/^      - /m).slice(1).map(s => '- ' + s)
const stepIndex = (list, re) => list.findIndex(s => re.test(s))

test('#1622 android-kotlin 在跑 gradle 之前還原／存 Gradle 相依套件快取（modules-2），key 綁 gradle 設定', () => {
  const list = steps(job('android-kotlin'))
  const cache = stepIndex(list, /gradle-deps-/)
  assert.ok(cache >= 0, '少了 gradle-deps 快取步驟')
  const s = list[cache]
  assert.match(s, /uses: actions\/cache@[0-9a-f]{40}/, '用 actions/cache（還原＋存）')
  assert.match(s, /~\/\.gradle\/caches\/modules-2\/files-2\.1/)
  assert.match(s, /hashFiles\([^)]*\.gradle[^)]*gradle-wrapper\.properties/, 'key 要綁 gradle 設定與 wrapper 版本')
  const firstGradlew = stepIndex(list, /\.\/gradlew/)
  assert.ok(firstGradlew > cache, '快取要在第一個 gradlew 呼叫之前還原')
})

test('#1622 gradle 的每個外部下載步驟都包在 retry-external.sh 裡（429／5xx 退避重試）', () => {
  const list = steps(job('android-kotlin')).filter(s => /\.\/gradlew/.test(s))
  assert.ok(list.length >= 3)
  for (const s of list) assert.match(s, /retry-external\.sh/, `gradlew 沒包重試：${s.split('\n')[0]}`)
})

test('#1627 gradle 發行包快取只存 zip，且還原後一定先用 distributionSha256Sum 核對再交給 wrapper', () => {
  const list = steps(job('android-kotlin'))
  const cache = stepIndex(list, /gradle-wrapper-zip-/)
  assert.ok(cache >= 0, '少了 gradle 發行包快取步驟')
  assert.match(list[cache], /path: ~\/\.gradle\/wrapper\/dists\/\*\/\*\/\*\.zip/, '只存下載回來的 zip，不存解開的檔')
  const verify = stepIndex(list, /name: 核對快取的 gradle 發行包/)
  assert.ok(verify > cache, '核對步驟要在快取還原之後')
  assert.match(list[verify], /distributionSha256Sum[\s\S]*sha256sum/)
  assert.match(list[verify], /rm -f "\$z"/, '雜湊不符要刪掉重抓')
  const firstGradlew = stepIndex(list, /\.\/gradlew/)
  assert.ok(verify < firstGradlew, '核對要在 wrapper 第一次執行之前')
  const props = rd('relay/asn/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties')
  assert.match(props, /^distributionSha256Sum=[0-9a-f]{64}\s*$/m, '核對用的雜湊要寫在 wrapper 設定裡')
})

test('#1796 build job 的 apt 安裝走 apt-install.sh（有整步上限），不直接 apt-get install', () => {
  const list = steps(job('build'))
  const inst = stepIndex(list, /id: aptinstall/)
  assert.ok(inst >= 0, '安裝系統依賴要呼叫 apt-install.sh')
  assert.match(list[inst], /timeout-minutes:\s*\d+/, '整步要有 timeout-minutes')
  assert.match(list[inst], /apt-install\.sh/)
  assert.match(list[inst], /APT_DEB_CACHE:/)
  assert.ok(!/apt-get install/.test(job('build')), 'workflow 裡不能繞過腳本直接 apt-get install')
  const pkgs = rd('.github/apt-build-packages.txt').split('\n').filter(l => l.trim() && !l.startsWith('#'))
  assert.ok(pkgs.length > 10, '套件清單不能是空的')
})

test('#1796 apt-install.sh：連線逾時、Acquire::Retries、最多 3 輪、每輪 timeout、換 azure 與官方鏡像', () => {
  assert.match(APT, /Acquire::Retries=\d+/)
  assert.match(APT, /Acquire::http::Timeout=\d+/)
  assert.match(APT, /ROUNDS=3/)
  assert.match(APT, /timeout "\$1" "\$\{APT\[@\]\}" install/, '每輪 install 都要有 timeout')
  assert.match(APT, /INSTALL_TIMEOUTS=\(\d+ \d+ \d+\)/)
  assert.match(APT, /azure\.archive\.ubuntu\.com/)
  assert.match(APT, /"http:\/\/archive\.ubuntu\.com\/ubuntu\/"/)
  assert.match(APT, /exit 1\s*$/, '三輪都失敗要以非 0 結束')
})

test('#1796 apt 快取只在安裝成功時存：workflow 的 save 步驟不用 always()，腳本只在 attempt 成功後 save_cache', () => {
  const list = steps(job('build'))
  const save = stepIndex(list, /actions\/cache\/save@/)
  assert.ok(save >= 0, '少了存快取步驟')
  const cond = list[save].match(/^\s+if: (.*)$/m)?.[1] ?? ''
  assert.match(cond, /steps\.aptinstall\.outcome == 'success'/)
  assert.doesNotMatch(cond, /always\(\)/, '失敗也存會讓半套 .deb 佔住該週 key')
  assert.ok(stepIndex(list, /actions\/cache\/restore@/) >= 0, '要有還原步驟')
  // 腳本：save_cache 的每一次呼叫（函式定義除外）都必須在 "if attempt" 成功分支內
  const calls = [...APT.matchAll(/^\s*save_cache\s*$/gm)]
  assert.ok(calls.length >= 1)
  for (const c of calls) {
    const before = APT.slice(0, c.index)
    const ifPos = before.lastIndexOf('if attempt')
    assert.ok(ifPos >= 0, 'save_cache 要在 if attempt 之內')
    assert.ok(!before.slice(ifPos).includes('fi\n'), 'save_cache 不能在 if 結束之後')
  }
})

// #1977 build 拆成 build 與 rust-test 之後，rust-test 也有一份 apt 安裝與快取：同樣要走 apt-install.sh、整步有上限、失敗不存快取
test('#1977 rust-test job 的 apt 安裝也走 apt-install.sh（有整步上限）、快取只在安裝成功時存', () => {
  const list = steps(job('rust-test'))
  const inst = stepIndex(list, /id: aptinstall/)
  assert.ok(inst >= 0, 'rust-test 要有「安裝系統依賴」')
  assert.match(list[inst], /timeout-minutes:\s*\d+/, '整步要有 timeout-minutes')
  assert.match(list[inst], /apt-install\.sh/)
  assert.match(list[inst], /APT_DEB_CACHE:/)
  assert.ok(!/apt-get install/.test(job('rust-test')), 'rust-test 不能繞過腳本直接 apt-get install')
  const save = stepIndex(list, /actions\/cache\/save@/)
  assert.ok(save >= 0, 'rust-test 少了存快取步驟')
  const cond = list[save].match(/^\s+if: (.*)$/m)?.[1] ?? ''
  assert.match(cond, /steps\.aptinstall\.outcome == 'success'/)
  assert.doesNotMatch(cond, /always\(\)/)
  assert.ok(stepIndex(list, /actions\/cache\/restore@/) >= 0, 'rust-test 要有還原快取步驟')
})
