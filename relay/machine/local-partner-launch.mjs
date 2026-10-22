#!/usr/bin/env node
// 本機開新夥伴（ASN 或命令列）：不經後台 launch 流程。
// 互動視窗：直接 spawn；背景工作者：寫入 partner-queue.jsonl 由機器橋消化。
import { envGet } from './env-compat.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectAgentTools } from '../shared/agent-tools-detect.mjs'
import { buildDefaultProfiles, defaultCwdAllow } from '../shared/launcher-profiles.mjs'
import { loadConfig, buildSpawn, check, childEnv, startWindow, NAME_RE, canonicalLaunchCwd } from './launcher.mjs'
import { createPartnerQueue } from './partner-background.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { profile: '', name: '', cwd: '', node: envGet(process.env, 'RELAY_ID') || 'H', queueOnly: false, display: 'foreground' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') out.profile = argv[++i] ?? ''
    else if (a === '--name') out.name = argv[++i] ?? ''
    else if (a === '--cwd') out.cwd = argv[++i] ?? ''
    else if (a === '--node') out.node = argv[++i] ?? out.node
    else if (a === '--display') out.display = argv[++i] === 'background' ? 'background' : 'foreground'
    else if (a === '--queue-only') out.queueOnly = true
    else if (a === '--help') out.help = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.profile || !args.name || !args.cwd) {
    console.error('用法：node local-partner-launch.mjs --profile <id> --name <名字> --cwd <資料夾> [--queue-only]')
    process.exit(args.help ? 0 : 2)
  }
  if (!NAME_RE.test(args.name)) {
    console.error('名字格式不對')
    process.exit(2)
  }
  const home = path.join(os.homedir(), '.irori-relay')
  const workDir = path.join(home, `machine-${args.node}`)
  const configPath = envGet(process.env, 'LAUNCHER_FILE') || path.join(home, 'launcher.json')
  const tools = await detectAgentTools()
  const bootstrap = { profiles: buildDefaultProfiles(tools), cwd_allow: defaultCwdAllow(), max_per_hour: 6 }
  const { config, error } = loadConfig(configPath, bootstrap)
  if (!config) {
    console.error(error || '無法載入啟動設定')
    process.exit(1)
  }
  const req = { profile: args.profile, name: args.name, cwd: canonicalLaunchCwd(args.cwd) }
  const why = check(config, req, { names: new Set() })
  if (why) {
    console.error(why)
    process.exit(1)
  }
  const prof = config.profiles[args.profile]
  if (prof.mode === 'background' || args.queueOnly) {
    const qfile = path.join(workDir, 'partner-queue.jsonl')
    const q = createPartnerQueue({ file: qfile, log: () => {}, onLaunch: async () => {} })
    q.enqueue({ profile: args.profile, name: args.name, cwd: req.cwd })
    console.log(JSON.stringify({ ok: true, mode: 'background', queued: true }))
    return
  }
  const prevStyle = envGet(process.env, 'LAUNCH_WINDOW_STYLE')
  if (args.display === 'background') envGet(process.env, 'LAUNCH_WINDOW_STYLE') = 'Hidden'
  try {
    const spawnSpec = buildSpawn(config, req, process.env, childEnv)
    const started = await startWindow(spawnSpec)
    console.log(JSON.stringify({ ok: true, mode: 'window', pid: started.pid, display: args.display }))
  } finally {
    if (args.display === 'background') {
      if (prevStyle === undefined) delete envGet(process.env, 'LAUNCH_WINDOW_STYLE')
      else envGet(process.env, 'LAUNCH_WINDOW_STYLE') = prevStyle
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
