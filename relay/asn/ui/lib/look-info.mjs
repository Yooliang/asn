// 「外觀」頁的平台差異（#1763 C3，規格 U5）。
// 「外觀」頁除了外觀三選一，還有視窗外框、視窗模式、頭像模式、工具列位置、文字底色、分頁依、分組依這一組自訂選項。
// 各平台有沒有這一組，以設定值清單（docs/設定值清單.md）第五章那幾列的平台欄為準：電腦「有」、手機「無（未做）」。
// 這不是平台做不到，而是設計上選擇不做（手機固定單欄、固定值），所以不放 caps（asn真 11-27 裁示：能力名稱不新增）；殼把這裡的值傳給 lookItems。
// test/look-panel.test.mjs 會拿清單比對這兩個值：清單改了、這裡沒跟上就會紅。
export const LOOK_CUSTOM = Object.freeze({ desktop: true, mobile: false })

// 手機固定的三個值（清單 dpMode、toolbar、bubble 三列的手機欄寫「無（未做）」＋固定值）：對話窗（chat-pane）一律用這三個，沒有選項可改。
// 原本寫死在 m.html 的 chat-pane 標籤上（dp-mode="inline"、toolbar="bottom"、bubble="auto"），現在由這裡取值，值照舊。
export const MOBILE_FIXED_LOOK = Object.freeze({ dpMode: 'inline', bubble: 'auto', toolbar: 'bottom' })
