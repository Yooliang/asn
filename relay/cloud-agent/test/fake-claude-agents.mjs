#!/usr/bin/env node
// 測試用：模擬 `claude agents --json`，內容由環境變數 FAKE_CLAUDE_AGENTS_JSON 提供
const args = process.argv.slice(2)
if (args[0] === 'agents' && args[1] === '--json') {
  process.stdout.write(process.env.FAKE_CLAUDE_AGENTS_JSON || '[]')
  process.exit(0)
}
process.stderr.write('fake-claude-agents: 不支援的參數\n')
process.exit(2)
