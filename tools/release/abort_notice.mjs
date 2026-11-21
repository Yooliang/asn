// 發版中止訊息的共用補充（電腦版 local_sign_publish 與 Linux linux_publish 都用）
// #1999：firebase 已部署、網站檔卻還沒提交回 main 就中止＝線上比 main 新；下次從 main 部署會把這版洗掉，中止訊息要講白
// completed 的每一項是「步驟號 步驟名」，例如「8 firebase 部署」
const has = (completed, name) => completed.some(c => c === name || String(c).endsWith(` ${name}`))
export const onlineAheadOfMain = (completed, version) =>
  has(completed, 'firebase 部署') && !has(completed, '提交回 main')
    ? `。⚠ 線上已是 v${version}、網站檔沒回 main：從 main 部署（含下一次發版）之前，要先把 site/public/index.html 與 site/public/update/latest.json 補提交回 main，否則會把這一版從官網洗掉`
    : ''
