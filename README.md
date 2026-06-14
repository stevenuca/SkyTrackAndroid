# SkyTrack Android

個人使用的即時航空圖 Android App。開啟後會顯示台灣周邊地圖及 OpenSky Network
提供的即時 ADS-B 航機位置，可搜尋航班代號或 ICAO24、查看飛行資訊，並把航班加入
手機本機的追蹤清單。

地圖右側的定位按鈕會在使用者主動點擊後要求 Android 位置權限，將地圖移到目前位置
並顯示定位精度範圍。App 不會在背景持續追蹤位置。

地圖支援單指拖曳、雙指縮放、雙擊放大及右側縮放按鈕。OpenSky 額度充足時每 10 秒
取得一次真實位置，畫面每秒依航向與速度做短時間位置推算；額度降低時會自動改為
30 或 60 秒，避免當日額度過早用完。

## 使用方式

1. 用 Android Studio 開啟 `SkyTrackAndroid`。
2. 等待 Gradle Sync 完成。
3. 連接 Android 手機或啟動模擬器後執行 `app`。

第一次開啟前，可參考 `local.properties.example` 建立自己的 `local.properties`。
`local.properties` 包含本機 SDK 路徑及未來可能加入的 API Key，已被 Git 排除。

也可在 PowerShell 執行：

```powershell
.\build-debug.ps1
```

Debug APK 會產生在 `app\build\outputs\apk\debug\app-debug.apk`。

## 資料來源與限制

- 即時航班狀態來自 OpenSky Network `GET /api/states/all`。
- 匿名使用者目前每日有 400 credits。一般地圖查詢只要求目前視窗範圍；輸入航班
  代號搜尋時會使用一次全球快照，成本較高。
- 匿名資料時間解析度為 10 秒。App 在前景時每 60 秒自動更新，也可手動更新。
- OpenSky 狀態資料不一定包含航空公司、起降機場、機型或航班計畫，因此 App 不會
  猜測這些欄位。
- 地圖圖磚來自 OpenStreetMap，僅載入使用者目前畫面，不提供離線下載或預抓。

若要長時間高頻率使用，應建立自己的後端，以 OpenSky OAuth2 client credentials
交換 access token，再由後端代理請求。不要把 `client_secret` 放進 APK。

## 更完整的航班資料

Google 航班搜尋畫面不是公開 API，不應直接爬取搜尋結果。若需要起飛／抵達機場、
預計與實際時間、延誤、航空公司、註冊編號及機型，可另外串接正式資料服務：

- AirLabs：即時航班、班表、路線、機型與航班狀態，需要 API Key。
- Aviationstack：航班狀態、起降機場與班表，需要 API Key。
- FlightAware AeroAPI：資料完整度較高，主要為付費商業服務。

建議保留 OpenSky 作為地圖位置來源，搜尋或開啟航班詳情時再向詳細資料 API 查詢，
可降低額度消耗。正式上線時，API Key 應放在自有後端，不應直接寫入 APK。

目前個人版會從 `local.properties` 的 `AIRLABS_API_KEY` 建置 AirLabs 詳情功能，並在
開啟航班詳情時查詢起降機場、時間、航廈、登機門、延誤、機型及註冊編號。相同航班
會快取 10 分鐘。由於 Android APK 可被逆向分析，此方式只適合個人使用；若要公開
發佈，應改由自有後端保管 API Key。
