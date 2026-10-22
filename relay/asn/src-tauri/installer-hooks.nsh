; 安裝程式的掛勾（Tauri 的 NSIS 範本會在對應時機呼叫這幾個巨集）。
;
; 命令列 asn-cli.exe 可能正在被 Claude 視窗跑著（asn-cli recv --watch 掛在 Monitor 上、長駐）。
; Windows 不允許覆蓋正在執行的檔案，但允許改名：更新前先把它改名成 asn-cli.old，新版再放進來；
; 舊的行程跑到結束為止不受影響，裝完後能刪的就順手刪掉（還在跑的下次安裝再清）。
; 密碼小幫手 asn-askpass.exe（git／ssh 要密碼時才被呼叫）同樣處理，原因相同。
; 只動我們自己的 asn-cli 與 asn-askpass，不碰其他程序。

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\asn-cli.old"
  IfFileExists "$INSTDIR\asn-cli.exe" 0 +2
    Rename "$INSTDIR\asn-cli.exe" "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  IfFileExists "$INSTDIR\asn-askpass.exe" 0 +2
    Rename "$INSTDIR\asn-askpass.exe" "$INSTDIR\asn-askpass.old"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
!macroend
