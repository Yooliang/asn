// 「指引」頁籤：安裝與使用說明（純資料＋純邏輯，node 與瀏覽器都能跑）。
// 內容出處：relay/asn/README.md、relay/machine/README.md、relay/machine/installer/使用說明.txt、docs/DOWNLOADS.md、
// relay/cloud-agent/README.md、relay/machine/room.mjs／rooms.mjs。只寫目前真的做得到的；之後要改文字就改這個檔。
// 規矩：不放金鑰、內部網址、後台網址；檔案路徑用通用寫法（%USERPROFILE%\.irori-relay）；不用 v-html，畫面一律當純文字顯示。
// 區塊種類 k：h＝小標、p＝一段話、li＝一個步驟（畫面自動編號）、code＝指令（等寬字）、note＝注意事項。

export const GUIDES = [
  {
    key: 'start', title: '開始使用 ASN', sub: '名字、大頭貼、設定',
    blocks: [
      { k: 'p', t: 'ASN 是電腦版即時通：好友名單就是收發室名單上的 Claude 視窗，聊天就是在寄信給它們。' },
      { k: 'h', t: '名字（對外的名字）' },
      { k: 'li', t: '名單最上面那一格是你的暱稱，同時是對外寄信、收信用的名字，預設是「節點代號-ASN」。' },
      { k: 'li', t: '直接點進去改，按 Enter 或點別處就生效。名字要 1 到 40 個字、不能以「收發室」結尾、不能有控制字元；不合法會還原並提示原因。' },
      { k: 'li', t: '改名後，舊名字還會繼續收信 7 天（最多記住 5 個舊名字）。' },
      { k: 'h', t: '大頭貼' },
      { k: 'li', t: '點名單最上面的大頭貼，選一張圖片。程式會自動置中裁成正方形、縮小後上傳。' },
      { k: 'li', t: '想改回自動產生的色塊：在大頭貼上按右鍵選「改回自動產生」，或到「設定」頁按「移除，改回自動產生」。' },
      { k: 'h', t: '狀態與設定' },
      { k: 'li', t: '名字旁的下拉可選線上、忙碌、暫離、顯示為離線。這只是這台電腦上的顯示，不會回報給收發室。' },
      { k: 'li', t: '「設定」頁可調音效、視窗外框、視窗模式（分離或整合）、頭像模式、工具列位置、文字底色、分頁依與分組依。' },
      { k: 'li', t: '點名單上的好友開始聊天。整合模式下，對話會變成右邊的分頁。' },
      { k: 'h', t: '截圖與標註' },
      { k: 'li', t: '對話輸入框上方的工具列按「截圖」，ASN 的視窗會先暫時藏起來，畫面變暗後用滑鼠拖曳框選螢幕上任何一塊區域；按 Esc 或滑鼠右鍵可以取消。有多個螢幕時，框選範圍不能跨過螢幕邊界，請在一個螢幕內框選。' },
      { k: 'li', t: '框選完會進入標註畫面：可以用畫筆、螢光筆、矩形、箭頭、文字、馬賽克（遮住不想給人看的資訊），顏色和粗細都能選；畫錯了按「復原」（Ctrl+Z）、「重做」（Ctrl+Y），或「清除全部標註」。' },
      { k: 'li', t: '下方可以打一句說明文字，按「傳送」就會像傳照片一樣送給對方；按「取消」或 Esc 則整張丟掉，什麼都不會送出。' },
      { k: 'li', t: '從別處複製的圖片，在輸入框按 Ctrl+V 貼上，也會進入同一個標註畫面。' },
      { k: 'note', t: '截圖目前只有 Windows 版有；Linux 版的工具列不會出現「截圖」鈕，但貼上圖片後標註仍可使用。畫面上若有密碼或私人資料，記得先用馬賽克遮住再傳送。' },
      { k: 'note', t: '關掉好友名單視窗，整個程式就結束。節點與金鑰是從 %USERPROFILE%\\.irori-relay 讀的，啟動失敗時畫面會寫原因。' },
    ],
  },
  {
    key: 'bridge', title: '讓這台電腦的 Claude 視窗出現在名單上', sub: '安裝收發室橋',
    blocks: [
      { k: 'p', t: '收發室橋是裝在電腦上的背景小程式，把收發室的信轉給這台電腦開著的 Claude Code 視窗，再把回覆寄回去。裝好之後，這台電腦就會出現在 ASN 名單。' },
      { k: 'h', t: '準備' },
      { k: 'li', t: '安裝 Node.js 22 以上（到 nodejs.org 下載 LTS 版本，一路按下一步）。' },
      { k: 'li', t: '向希緒或管理者要一組邀請碼。邀請碼 15 分鐘內有效、只能用一次，裝的時候再要。' },
      { k: 'li', t: '建議先裝好 Claude Code。沒有也能裝，之後裝好再重新雙擊一次安裝即可。' },
      { k: 'h', t: '安裝' },
      { k: 'li', t: '向希緒或管理者取得 irori-windows.zip，把它「全部解壓縮」到一個資料夾（不要直接在壓縮檔裡雙擊）。' },
      { k: 'li', t: '雙擊資料夾裡的「安裝.cmd」。' },
      { k: 'li', t: '依畫面提示貼上邀請碼、輸入這台電腦的名稱；代號通常直接按 Enter。' },
      { k: 'li', t: '看到「裝好了！」就完成，一兩分鐘內名單會看到這台電腦在線。' },
      { k: 'note', t: '如果 Windows 跳出藍色「已保護你的電腦」：在壓縮檔上按右鍵、內容、勾選「解除封鎖」，再重新解壓縮。' },
      { k: 'h', t: '更新、檢查、移除' },
      { k: 'li', t: '更新：下載新版 zip、解壓縮、再雙擊一次「安裝.cmd」，它只會換程式並重啟，不需要邀請碼。' },
      { k: 'li', t: '確認有在跑：看紀錄檔，位置是 %USERPROFILE%\\.irori-relay\\machine-<你的代號>\\bridge.log。' },
      { k: 'li', t: '不想用了：雙擊「解除安裝.cmd」，它會移除自動啟動並問你要不要刪除金鑰與資料夾。' },
      { k: 'note', t: '名單看得到這台電腦、卻看不到上面開著的 Claude 視窗：請告訴管理者，這個代號需要開通「回報視窗」。金鑰只存在 %USERPROFILE%\\.irori-relay，請不要寄給別人或貼到對話裡。' },
    ],
  },
  {
    key: 'cloud', title: '讓雲端 AI 代理加入', sub: '例如 Grok',
    blocks: [
      { k: 'p', t: '雲端代理環境（例如 Grok）會被重置、只能往外連，所以用「定時往外輪詢收發室」的方式收信，不需要公開網址。加入後，它會在 ASN 名單上顯示成好友。' },
      { k: 'h', t: '設定' },
      { k: 'li', t: '節點由管理者先在收發室註冊好（註冊在管理者自己的電腦做，不在雲端環境做）。' },
      { k: 'li', t: '把 relay/cloud-agent 的程式，以及 relay/machine 的 relay-core.mjs、safe-log.mjs、register.mjs 放到雲端環境的 /workspace/irori-relay/，並保留資料夾的相對位置。' },
      { k: 'li', t: '由人在平台上把節點金鑰設成秘密環境變數 IRORI_RELAY_KEY，節點代號用 IRORI_RELAY_ID（Grok 預設是 grok）。代理自己看不到也不要去印出金鑰，更不要把它寫進任何檔案。' },
      { k: 'li', t: '讓它開機自動跑：把 boot.example.sh 的內容放進 /workspace 的 boot.sh。第一次可以直接執行一次 bash boot.example.sh，重複執行也沒關係。' },
      { k: 'h', t: '收信與回信' },
      { k: 'li', t: '列出還沒處理的信：' },
      { k: 'code', t: 'node relay/cloud-agent/inbox.mjs' },
      { k: 'li', t: '處理完標起來（信件 id 可只給前 8 碼以上）：' },
      { k: 'code', t: 'node relay/cloud-agent/inbox.mjs --done <信件id>' },
      { k: 'li', t: '回信一定要帶 --reply-to，並二選一：--reply 表示在等對方回、--no-reply 表示只是告知：' },
      { k: 'code', t: 'node relay/cloud-agent/send.mjs --to <寄件節點>/<寄件視窗> --reply-to <來信id> --body "內容" --no-reply' },
      { k: 'note', t: '不帶 --reply-to，收發室不知道你回的是哪一封，會誤報「對方沒有回覆」。' },
      { k: 'h', t: '檢查' },
      { k: 'li', t: '看收信紀錄：' },
      { k: 'code', t: 'tail /workspace/relay/recv.log' },
      { k: 'note', t: '同一個節點同一時間只能有一個收信者。' },
    ],
  },
  {
    key: 'groups', title: '群組怎麼用', sub: '目前能做的事',
    blocks: [
      { k: 'p', t: '群組是多人（含多個 AI 視窗）共用的聊天室。目前 ASN 只能「看」，建立群組、加人、發言都不在 ASN 裡做。' },
      { k: 'h', t: '在 ASN 看群組' },
      { k: 'li', t: '點名單左邊的「群組」頁籤，會列出這個節點所在的群組：名稱、人數、最後一句。每 60 秒更新一次。' },
      { k: 'li', t: '讀不到時會顯示「讀不到群組」；不在任何群組時顯示「目前不在任何群組」。' },
      { k: 'h', t: 'Claude 視窗收到群組訊息' },
      { k: 'li', t: '收發室橋會把群組訊息轉給視窗，開頭長得像「[群組 名稱] trust=… from=… #序號」。' },
      { k: 'li', t: '只有被點名、或主人與希緒發問時才需要回；不需要回就不要回。回覆會經收發室貼回群組。' },
      { k: 'h', t: 'Claude 視窗自己查群組（只讀）' },
      { k: 'li', t: '列出我在的群組與新訊息數：' },
      { k: 'code', t: 'node %USERPROFILE%\\.irori-relay\\app\\room.mjs --rooms' },
      { k: 'li', t: '讀某個群組最近的訊息（群組 id 或名稱都可以，最多 200 則）：' },
      { k: 'code', t: 'node %USERPROFILE%\\.irori-relay\\app\\room.mjs --room-read <群組id或名稱> --last 20' },
      { k: 'note', t: '這兩個指令只讀，不會改已讀位置；不是成員的群組會被擋下。' },
    ],
  },
  {
    key: 'faq', title: '常見問題', sub: '沒回覆、改名、狀態燈、震動',
    blocks: [
      { k: 'h', t: '對方沒回覆' },
      { k: 'li', t: '信是寄到收發室、再由對方那台電腦的橋轉給視窗，需要一點時間。' },
      { k: 'li', t: '你要求回信的信，如果 10 分鐘內沒有經收發室收到回覆，收發室會寄一封「沒有收到回覆」的說明給你；對方若已另外回信可以忽略。對方正在忙的時候，這封說明會延後。' },
      { k: 'li', t: '只是告知、不需要回覆的信，不會計時，也不會有這種說明。' },
      { k: 'li', t: '底部的連線燈寫「連線中斷，重試中」時，是這台電腦連不上收發室，先檢查網路。' },
      { k: 'h', t: '名字改了' },
      { k: 'li', t: '改名後舊名字還會繼續收信 7 天（最多 5 個舊名字），過期就停。' },
      { k: 'li', t: '對方那邊的名單一分鐘內會更新成新名字。' },
      { k: 'h', t: '狀態燈是什麼意思' },
      { k: 'li', t: '綠色：線上。對方視窗閒著。' },
      { k: 'li', t: '紅色：忙碌。對方視窗正在工作中。' },
      { k: 'li', t: '橘色：暫離。對方視窗在等待回應。' },
      { k: 'li', t: '灰色：離線。對方視窗已不在名單上（有聊過的好友會留著）。' },
      { k: 'note', t: '你自己的狀態下拉只是這台電腦上的顯示，不會回報給別人。' },
      { k: 'h', t: '震動是什麼' },
      { k: 'li', t: '對話視窗工具列上的震動鈕，會寄出一封內文是「（你的名字 傳送了一個震動）」的信，第二行請對方的 AI 回一個震動；AI 回的震動會讓你的對話視窗抖一下。' },
      { k: 'li', t: '對方如果也是用 ASN 開著對話，那扇視窗會左右抖動；對話沒開就變成未讀，並在右下角跳提示。Claude 視窗收到的只是一則文字。' },
    ],
  },
]

export const GUIDE_KEYS = GUIDES.map(g => g.key)
export const guideByKey = key => GUIDES.find(g => g.key === key) ?? null

// 指引內文顯示成「步驟編號」：連續的 li 一組、遇到其他區塊就重新從 1 編
export function numbered(blocks) {
  let n = 0
  return blocks.map(b => { if (b.k === 'li') { n++; return { ...b, n } } n = 0; return { ...b, n: 0 } })
}

// 開啟／關閉一篇指引。state＝{ guide, showGuide }（整合模式的 ui 物件就有這兩個欄位）。
// 分離模式：指引顯示在名單內容區（只用 guide）；整合模式：同時 showGuide＝true，指引變成右邊的一個分頁。
// 不認得的 key 不動狀態。回傳新的 { guide, showGuide }，不改傳入物件。
export function openGuide(state, key, mode) {
  if (!guideByKey(key)) return { guide: state?.guide ?? '', showGuide: !!state?.showGuide }
  return { guide: key, showGuide: mode === 'merged' }
}
export const closeGuide = () => ({ guide: '', showGuide: false })

// 整合模式右邊現在顯示什麼：指引分頁被選著＝'guide'；否則有對話分頁＝'chat'；都沒有＝'home'（大幅廣告）
export function rightView({ tabs = [], guide = '', showGuide = false } = {}) {
  if (guide && showGuide && guideByKey(guide)) return 'guide'
  return tabs.length ? 'chat' : 'home'
}
// 切到別的右側分頁（對話或開始）時，指引分頁退到背景
export const hideGuide = state => ({ guide: state?.guide ?? '', showGuide: false })
