; 安裝程式的掛勾（Tauri 的 NSIS 範本會在對應時機呼叫這幾個巨集）。
;
; 命令列 asn-cli.exe 可能正在被 Claude 視窗跑著（asn-cli recv --watch 掛在 Monitor 上、長駐）。
; Windows 不允許覆蓋正在執行的檔案，但允許改名：更新前先把它改名成 asn-cli.old，新版再放進來；
; 舊的行程跑到結束為止不受影響，裝完後能刪的就順手刪掉（還在跑的下次安裝再清）。
; 密碼小幫手 asn-askpass.exe（git／ssh 要密碼時才被呼叫）同樣處理，原因相同。
; 只動我們自己的 asn-cli 與 asn-askpass，不碰其他程序。
;
; 0.2.0 起附帶 WezTerm（$INSTDIR\wezterm 底下 7 個檔，清單與 scripts/fetch-wezterm.mjs 的 WEZTERM_FILES 一致，測試會核對）。
; 夥伴的窗格跑在 mux-server 底下、ASN 關掉也不停，所以更新時 mux-server、conpty.dll、OpenConsole.exe 多半還被占用；
; 看畫面的 wezterm-gui.exe 與 EGL dll 也可能被占用。處理方式同上：改名成 .old 再放新檔，舊的程序繼續跑到下次重開
; （見 docs/design/WEZTERM.md 第十一節第 8 點）。
; 規則：只改 $INSTDIR\wezterm 裡的檔；改名前先刪舊的 .old；刪不掉（舊程序還在跑）就依序改用 .old1、.old2 … .old9，
; 全都被占用就放棄這個檔的改名；任何失敗都不中止安裝（NSIS 的 Delete、Rename 失敗只設錯誤旗標）。不殺任何程序。

; 試一個備份名：先刪，刪不掉（還在）就跳過下面兩行去試下一個；刪掉了就改名並結束
!macro ASN_TRY_OLD ID FILE SUF
  Delete "$INSTDIR\wezterm\${FILE}${SUF}"
  IfFileExists "$INSTDIR\wezterm\${FILE}${SUF}" +3 0
    Rename "$INSTDIR\wezterm\${FILE}" "$INSTDIR\wezterm\${FILE}${SUF}"
    Goto asn_done_${ID}
!macroend

; ID 是唯一的編號（標籤名用），FILE 是 wezterm 資料夾內的檔名
!macro ASN_ROTATE ID FILE
  IfFileExists "$INSTDIR\wezterm\${FILE}" 0 asn_done_${ID}
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old1
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old2
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old3
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old4
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old5
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old6
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old7
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old8
  !insertmacro ASN_TRY_OLD ${ID} ${FILE} .old9
  asn_done_${ID}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\asn-cli.old"
  IfFileExists "$INSTDIR\asn-cli.exe" 0 +2
    Rename "$INSTDIR\asn-cli.exe" "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  IfFileExists "$INSTDIR\asn-askpass.exe" 0 +2
    Rename "$INSTDIR\asn-askpass.exe" "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\*.old*"
  !insertmacro ASN_ROTATE 1 wezterm-gui.exe
  !insertmacro ASN_ROTATE 2 wezterm.exe
  !insertmacro ASN_ROTATE 3 wezterm-mux-server.exe
  !insertmacro ASN_ROTATE 4 conpty.dll
  !insertmacro ASN_ROTATE 5 OpenConsole.exe
  !insertmacro ASN_ROTATE 6 libEGL.dll
  !insertmacro ASN_ROTATE 7 libGLESv2.dll
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\*.old*"
!macroend

; 解除安裝前：刪掉「ASN 意外關閉時自動重新開啟」建的工作排程（todo-next-191 B1）。排程名由 asn.exe 自己算
; （使用者名，或有中文、空白時用雜湊；見 src/guard.rs 的 task_name），所以交給還在的 asn.exe --guard-remove 處理，
; NSIS 不另算一份。找不到排程、刪不掉、asn.exe 不在，都不擋解除安裝（ClearErrors）。
; 更新時 Tauri 的安裝程式會用 /UPDATE 跑舊版的解除安裝（範本 un.onInit 會設 $UpdateMode = 1）：那不是真的解除安裝，
; 排程要留著，不然每次更新都會把使用者勾的「自動重新開啟」默默關掉
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    IfFileExists "$INSTDIR\asn.exe" 0 +2
      ExecWait '"$INSTDIR\asn.exe" --guard-remove'
    ClearErrors
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\asn-cli.old"
  Delete "$INSTDIR\asn-askpass.old"
  Delete "$INSTDIR\wezterm\*.old*"
!macroend
