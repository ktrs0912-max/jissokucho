# ピタ測を Google Play で販売するための手順

ピタ測は、ウェブ上のピタ測を Android アプリとして包む作り（TWA）で Play に出します。
アプリの中身はウェブ版と同じなので、ウェブ版を直せば Play 版も自動で新しくなります（アプリの出し直しは不要）。

アプリ側の準備（このリポジトリの中）は済んでいます。下の **【あなたがやること】** を上から順に進めてください。

---

## 0. 準備できているもの

| もの | 場所 |
|---|---|
| アプリのアイコン（512×512、Android用の切り抜き対応版も） | `icon-512.png`、`icon-maskable-512.png` |
| プライバシーポリシーのページ | `privacy.html`（【 】の所を埋める） |
| ストアに出す紹介画像（1024×500） | `play/images/feature-graphic-1024x500.png` |
| スマホの画面写真（3枚） | `play/images/phone-*.png` |
| タブレットの画面写真（2枚） | `play/images/tablet-*.png` |
| ストアの説明文の下書き | `play/listing.md` |
| データ セーフティ（データの扱い）の答え方 | `play/data-safety.md` |
| Play 版以外で開いた時に購入を案内する仕組み | `app.js` の `PLAY`（今は止めてある） |

---

## 1. 【あなたがやること】今どこで公開しているか確かめる

1. パソコンのブラウザで https://github.com/ktrs0912-max/jissokucho を開く
2. 上の「Settings」→ 左の「Pages」を開く
3. 「Your site is live at ○○○」と出ていれば、その ○○○ が公開先です
   - 多くの場合 `https://ktrs0912-max.github.io/jissokucho/` です
   - 何も出ていなければ、「Branch」で `main`、フォルダ `/ (root)` を選んで「Save」すると公開されます

> **大事**：このリポジトリは今「Public（誰でも見られる）」です。有料で売るなら、中身（ソースコード）を誰でもコピーできる状態は避けたいところです。
> GitHub Pages を非公開のリポジトリで使うには GitHub の有料プラン（Pro、月4ドル程度）が必要です。
> 代わりに Cloudflare Pages など、非公開リポジトリから無料で公開できる所へ移す方法もあります。どちらにするか決めてください（移す作業は手伝えます）。

## 2. 【あなたがやること】Google Play の開発者登録

1. https://play.google.com/console で開発者アカウントを作る（登録料 25ドル・1回だけ）
2. 本人確認（身分証）を済ませる
3. **有料アプリにするため、「お支払いプロファイル（販売者アカウント）」も作る**（銀行口座を登録）
4. 個人のアカウントで新しく作った場合、**本番公開の前に「クローズド テスト」を 12人以上で 14日間** 行う決まりがあります。
   テストしてくれる人（同業の知り合いなど）を 12人集めておいてください（Gmail アドレスが必要）。

## 3. 【あなたがやること】Android アプリ（.aab）を作る

PWABuilder（Microsoft の無料サービス）を使うと、ブラウザだけで作れます。

1. https://www.pwabuilder.com を開き、公開先のURL（例：`https://ktrs0912-max.github.io/jissokucho/`）を入れて「Start」
2. 「Package For Stores」→「Android」→「Generate Package」の横の「Options」を開き、次のように入れる

   | 項目 | 入れる値 |
   |---|---|
   | Package ID | `io.github.ktrs0912max.pitasoku`（一度決めたら変えられません。独自ドメインを取るなら `jp.〇〇.pitasoku` など） |
   | App name | `ピタ測 - 図面に番号を打つ実測アプリ` |
   | Launcher name | `ピタ測` |
   | App version / version code | `1.0.0` / `1` |
   | Display mode | Standalone |
   | Status bar color / Nav bar color | `#2a8c80` / `#ffffff` |
   | Splash screen color | `#f3f8f5` |
   | Signing key | **New**（新しく作る） |

3. 「Generate」で zip ファイルができる。中に次のものが入っています
   - `○○.aab` … Play に上げるアプリ本体
   - `signing.keystore` と `signing-key-info.txt` … **アプリの鍵。なくすとアプリを更新できなくなります。** USBメモリやパスワード付きの場所など、2か所以上に大切に保管してください（GitHub には絶対に上げない）
   - `assetlinks.json` … 次の「4」で使う

## 4. 【あなたがやること】アプリとウェブを結びつける（assetlinks.json）

Play のアプリがウェブ版を「自分のもの」として全画面で開くために、証明ファイルを **公開先の住所の一番上** に置きます。

- 置く場所：`https://ktrs0912-max.github.io/.well-known/assetlinks.json`
  - `jissokucho/` の下ではなく、**一番上** です。そのため GitHub に `ktrs0912-max.github.io` という名前のリポジトリをもう1つ作り、その中に `.well-known/assetlinks.json` を置いて Pages を有効にします
  - 独自ドメインを使う場合は、そのドメインの一番上に置きます
- 中身：PWABuilder が作った `assetlinks.json` に、**Play Console の「アプリの署名」に出る SHA-256 の指紋も追加** します（Play が鍵をかけ直すため、指紋が2つになります）。形は `play/assetlinks.example.json` を見てください
- 置けたら https://developers.google.com/digital-asset-links/tools/generator で確かめられます

うまく結びついていないと、アプリの上にブラウザのアドレス欄が出ます。

## 5. 【あなたがやること】Play Console でアプリを作って公開する

1. 「アプリを作成」→ 名前「ピタ測 - 図面に番号を打つ実測アプリ」、言語「日本語」、**「有料」** を選ぶ（後から無料→有料には変えられません）
2. 「ストアの掲載情報」に `play/listing.md` の文と `play/images` の画像を入れる
3. 「アプリのコンテンツ」で次を答える
   - プライバシーポリシー：公開先の `privacy.html` のURL（例：`https://ktrs0912-max.github.io/jissokucho/privacy.html`）
   - 広告：含まない
   - アプリのアクセス権：制限なし（ログインなしで全部使える）
   - コンテンツのレーティング：アンケートに答える（暴力などはすべて「いいえ」）
   - ターゲット ユーザー：18歳以上
   - データ セーフティ：`play/data-safety.md` のとおり
4. 「価格」を決める（例：980円）
5. 「テスト」→「クローズド テスト」に `.aab` を上げ、12人以上を招待して 14日間使ってもらう
6. 14日たったら「本番」へ公開を申請する（審査は数日〜1週間ほど）

## 6. 【公開した後】Play 版以外で開けないようにする

Play で公開されたら、`app.js` の次の行を書き換えてください（言ってもらえれば私が直します）。

```js
const PLAY = { only: true, pkg: 'io.github.ktrs0912max.pitasoku', url: 'https://play.google.com/store/apps/details?id=io.github.ktrs0912max.pitasoku' };
```

こうすると、ブラウザで直接開いた人には「Google Play で販売しています」という案内が出て、使えなくなります。
（Play 版から一度開いた端末は、その後ブラウザで開いても使えます。完全に防ぐ仕組みではありません）

## 7. Googleドライブ同期について

一般の人がドライブ同期を使えるようにするには、Google Cloud の「OAuth 同意画面」を「本番環境」にして、Google の確認を受ける必要があります。

1. https://console.cloud.google.com でプロジェクト「jissokucho」を開く
2. 「APIとサービス」→「OAuth 同意画面」で、アプリ名「ピタ測」、ロゴ（`icon-512.png`）、ホームページ（公開先のURL）、プライバシーポリシーのURL、承認済みドメイン（`github.io` または独自ドメイン）を入れる
3. 「アプリを公開」を押す
   - ピタ測は「このアプリが作ったファイルだけ」の権限（drive.file）なので、厳しい審査はありません
   - 確認を受けないままだと、ログインの時に「このアプリは確認されていません」と出たり、使える人数が100人までになったりします

---

## 参考：ほかの売り方を選ぶ場合

- **月額にしたい**：Play の定期購入の仕組み（Play Billing）をアプリに組み込む大きな作業になります
- **ウェブ版も残して売りたい**：Play 版とは別に、ログインと支払いの仕組みが必要になります
