// 本機視窗身分的共用判定（send.mjs、recv.mjs 共用）：機器節點、機器金鑰，以及「呼叫者是哪個引擎的哪個視窗」。
// 寄件／收件視窗名不能自填：一律由引擎的身分判定（Claude：父行程鏈／環境變數 → ~/.claude/sessions）對照出來。
// 引擎相關的部分在 engines/（見 engines/identity-providers.mjs）；這裡保留舊的匯出名稱，行為不變。
import { envGet } from './env-compat.mjs'
import { HOME_DIR, locateHome } from './home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { identityProviders } from './engines/identity-providers.mjs'

export { alivePid, processTable, readSession, sessionsDir } from './engines/claude-identity.mjs'

export { HOME_DIR }
export const BASE_URL = (envGet(process.env, 'RELAY_URL') || 'https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay').replace(/\/+$/, '')

export class Fail extends Error { constructor(code, msg) { super(msg); this.code = code } }

// 機器節點：ASN_RELAY_ID（舊名 IRORI_RELAY_ID） → ~/.asn/node → 橋正在跑的 machine-<ID> → 唯一有金鑰檔的 machine-<ID>
export function machineNode() {
  const env = (envGet(process.env, 'RELAY_ID') || '').trim()
  if (env) return env
  try { const v = fs.readFileSync(locateHome('node'), 'utf8').trim(); if (v) return v } catch {}
  let ids = []
  try { ids = fs.readdirSync(HOME_DIR).filter(n => /^machine-[A-Za-z0-9_-]+$/.test(n)).map(n => n.slice('machine-'.length)) } catch {}
  const alive = id => { try { process.kill(Number(fs.readFileSync(locateHome(`machine-${id}`, 'bridge.pid'), 'utf8')), 0); return true } catch (e) { return e.code === 'EPERM' } }
  const live = ids.filter(alive)
  if (live.length === 1) return live[0]
  const keyed = ids.filter(id => fs.existsSync(locateHome(`${id}.key`)))
  if (keyed.length === 1) return keyed[0]
  throw new Fail(1, `認不出這台機器的節點代號（候選：${(live.length ? live : keyed.length ? keyed : ids).join('、') || '無'}）：設環境變數 ASN_RELAY_ID，或在 ~/.asn/node 寫上節點代號`)
}

// 判定呼叫者的證據（--whoami 用）：預設問第一個引擎（claude）；providers 可注入（測試／新引擎）
export function inspectCaller(providers = identityProviders) {
  return providers[0].inspectCaller()
}
// 依序問每個引擎，第一個命中的就是呼叫者；回傳 { pid, name, engine }
export function findCaller(what = '寄信', providers = identityProviders) {
  let first = null
  for (const p of providers) {
    const ev = p.inspectCaller()
    first ??= ev
    const hit = ev.viaChain ?? ev.viaEnv
    if (hit) {
      if (!hit.name) throw new Fail(2, `找到 ${p.engine} 視窗（pid ${hit.pid}）但它沒有名字，無法當${what === '收信' ? '收件人' : '寄件人'}；請先 /rename`)
      return { pid: hit.pid, name: hit.name, engine: p.engine }
    }
  }
  throw new Fail(2, `拒絕：找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能${what}）${first?.tableError ? `；讀行程表失敗：${first.tableError}` : ''}\n除錯：加 --whoami 看父行程鏈與 session 對照`)
}

// 機器金鑰：ASN_RELAY_KEY（舊名 IRORI_RELAY_KEY）優先，否則 ~/.asn/<節點>.key（橋用的同一把）
export function readMachineKey(node) {
  let key = (envGet(process.env, 'RELAY_KEY') || '').trim()
  if (!key) { try { key = fs.readFileSync(locateHome(`${node}.key`), 'utf8').trim() } catch {} }
  if (!key) throw new Fail(1, `找不到機器金鑰 ${path.join(HOME_DIR, node + '.key')}`)
  return key
}
