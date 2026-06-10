# live-status

[realtimeearth.com/haneda](https://realtimeearth.com/haneda/) の羽田空港マルチビューが参照する `live.json`（各チャンネルの現在ライブ中の videoId）を、GitHub Actions の 5 分 cron で自動更新するリポジトリ。

| ファイル | 役割 |
|---|---|
| `feeds.json` | 追跡するチャンネル・配信の定義 |
| `resolver.mjs` | YouTube Data API でライブ状態を解決（Node 20・依存なし） |
| `live.json` | 自動生成される成果物（クライアントが raw URL で取得） |

掲載チャンネルの映像はすべて各運営者が YouTube で公開しているライブ配信であり、本リポジトリは公開済みの video ID とライブ状態のみを扱います。
