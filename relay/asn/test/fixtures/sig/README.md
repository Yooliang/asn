# 驗簽黃金樣本

`tools/release/verify_sig.mjs` 的測試資料，由 **Tauri 簽章工具**（`@tauri-apps/cli` 2.12.3 的 `tauri signer`）用**拋棄式金鑰**產出，不是真正的更新簽章金鑰：

- `ASN_0.0.1_x64-setup.exe`：4096 位元組的假安裝檔（開頭 `MZ`，其餘由固定種子的 sha256 鏈產生，內容固定）
- `ASN_0.0.1_x64-setup.exe.sig`：上面那個檔的簽章（base64 外殼）
- `throwaway.pub`：拋棄式公鑰（格式與 `tauri.conf.json` 的 `plugins.updater.pubkey` 相同）

私鑰與密碼不進 repo（用完即丟）。重產方式：

```
npm i @tauri-apps/cli@2.12.3            # 放在 repo 以外的暫存資料夾
tauri signer generate -w throwaway.key -p "<隨便一個密碼>" --ci
# 重新產一個檔（任何內容皆可，檔名要維持 ASN_0.0.1_x64-setup.exe）
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<同上>" tauri signer sign -f throwaway.key --app-version 0.0.1 ASN_0.0.1_x64-setup.exe
cp throwaway.key.pub throwaway.pub
```

重產後 `.sig`、`.pub` 兩個檔要一起換（金鑰變了舊簽章就驗不過）。這些檔在 `.gitattributes` 標成 binary，不要被換行轉換。
