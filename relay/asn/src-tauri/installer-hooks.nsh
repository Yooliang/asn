; 安裝程式的掛勾（Tauri 的 NSIS 範本會在對應時機呼叫這幾個巨集）。
;
; 命令列 asn-cli.exe 可能正在被 Claude 視窗跑著（asn-cli recv --watch 掛在 Monitor 上、長駐）。
; Windows 不允許覆蓋正在執行的檔案，但允許改名：更新前先把它改名成 asn-cli.old，新版再放進來；
; 舊的行程跑到結束為止不受影響，裝完後能刪的就順手刪掉（還在跑的下次安裝再清）。
; 密碼小幫手 asn-askpass.exe（git／ssh 要密碼時才被呼叫）同樣處理，原因相同。
; 只動我們自己的 asn-cli 與 asn-askpass，不碰其他程序。
;
; 0.2.0 起附帶 WezTerm 的 mux-server（$INSTDIR\wezterm\wezterm-mux-server.exe），夥伴的窗格跑在它底下、ASN 關掉也不停，
; 所以更新時它多半還在跑。處理方式同上：改名成 .old 再放新檔，舊 mux 繼續跑到下次重開（見 docs/design/WEZTERM.md 第十一節第 8 點）。
; 規則：只改 wezterm 資料夾裡的 mux 執行檔；已存在的 .old 先刪；改名失敗不中止安裝（NSIS 的 Rename 失敗只設錯誤旗標）。
; 不碰 conpty.dll、OpenConsole.exe（也被 mux 占用，留給 B4 實測）。裝完不在這裡殺任何程序。

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\asn-cli.old"
  IfFileExists "$INSTDIR\asn-cli.exe" 0 +2
    Rename "$INSTDIR\asn-cli.exe" "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  IfFileExists "$INSTDIR\asn-askpass.exe" 0 +2
    Rename "$INSTDIR\asn-askpass.exe" "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\wezterm-mux-server.old"
  IfFileExists "$INSTDIR\wezterm\wezterm-mux-server.exe" 0 +2
    Rename "$INSTDIR\wezterm\wezterm-mux-server.exe" "$INSTDIR\wezterm\wezterm-mux-server.old"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\wezterm-mux-server.old"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\wezterm-mux-server.old"
!macroend
