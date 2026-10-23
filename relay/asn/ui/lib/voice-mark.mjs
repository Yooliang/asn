// 語音通話標記（畫面端）：通話中說的話辨識成文字後寄出，寄信時帶結構化旗標 voice（見 core.mjs 的 send）。
// 對話畫面上，那一則顯示「🎤 語音」小標示。本機記錄有 voice 旗標就算；從後台補回來的舊記錄沒有旗標，
// 退而看內文第一行是不是通話提示（只影響自己這邊的畫面，收信端只認結構化旗標，不看內文）。
import { CALL_MARKER } from './call-session.mjs'

export const isVoiceMsg = m => m?.voice === true || (m?.k === 'me' && typeof m?.text === 'string' && m.text.startsWith(CALL_MARKER))
