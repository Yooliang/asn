// 靜態守門：每一條開 Claude 夥伴的路，開窗之前都要先把工作資料夾標成已信任（#1632）。
// 讀 Rust 原始碼字串，不跑 Rust。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = f => fs.readFileSync(path.join(root, 'src-tauri/src', f), 'utf8').replace(/\r\n/g, '\n')
const prod = t => t.split('#[cfg(test)]')[0]
const body = (t, from, to) => {
  const a = t.split(from)[1]
  assert.ok(a, `找不到 ${from}`)
  return a.split(to)[0]
}

test('重開（喚醒、交接、改名、換模型）的開窗點先信任 Claude 的資料夾', () => {
  const local = prod(src('launch/local.rs'))
  const relaunch = body(local, 'pub(super) fn start_window_relaunch', '\n}')
  const trust = relaunch.indexOf('pretrust::ensure_claude_command_cwd_trusted(command, cwd)')
  assert.ok(trust >= 0, 'start_window_relaunch 要呼叫信任函式')
  assert.ok(trust < relaunch.indexOf('start_window'), '信任要在開窗之前')
})

test('real_launch 走會先信任的重開開窗點', () => {
  const real = body(src('launch/switch.rs'), 'pub(crate) fn real_launch', 'pub(crate) struct RealOs')
  assert.ok(real.includes('local::start_window_relaunch('))
  // 喚醒、重開（改名／交接）、換模型都經 env.launch／real_launch
  const ops = src('bridge/partner_ops.rs')
  assert.ok(body(ops, 'fn launch(&self, plan: &Plan) -> Result<(), String> {', '}').includes('switch::real_launch(plan)'))
  assert.ok(body(ops, '    fn resume(&self, op: &Op)', '    /// 找不到對話檔時').includes('self.env.launch(&plan)'), '喚醒走 env.launch')
  assert.ok(body(ops, '    fn reopen(', '    fn still_open_note').includes('self.env.launch(&plan)'), '重開（改名、交接）走 env.launch')
})

test('本機新增、遠端開窗、開機接回都呼叫同一個信任函式，空 engine 也算 Claude', () => {
  const local = prod(src('launch/local.rs'))
  assert.ok(body(local, 'pub fn partner_launch_local', 'pub(crate) enum ModelPlan').includes('pretrust::ensure_claude_cwd_trusted(prof.engine.as_str(), &launch_req.cwd)'))
  assert.ok(body(local, 'pub fn start_remote_window', 'pub fn start_resumed_window').includes('pretrust::ensure_claude_cwd_trusted(&prof.engine, cwd)'))
  assert.ok(body(local, 'pub fn start_resumed_window', 'pub fn start_pi_session').includes('pretrust::ensure_claude_cwd_trusted("claude", &req.cwd)'))
  assert.ok(!local.includes('fn maybe_trust_claude_cwd'), '舊的只認 engine==claude 的函式不能回來')
  const pre = prod(src('launch/pretrust.rs'))
  assert.ok(pre.includes('engine.is_empty() || engine == "claude"'))
})

test('信任寫到 Claude 實際讀的那份：CLAUDE_CONFIG_DIR 優先，失敗記 ui.log', () => {
  const pre = prod(src('launch/pretrust.rs'))
  assert.ok(pre.includes('CLAUDE_CONFIG_DIR'))
  assert.ok(pre.includes('ui_log::append'))
  assert.ok(pre.includes('開夥伴前沒能把工作資料夾標成已信任'))
})
