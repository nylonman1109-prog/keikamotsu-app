#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   新しい会社ぶんのアプリを作る（1社1アプリ方式）

   使い方（PowerShell）:
     cd C:\Users\ironm\repos\keikamotsu-app
     node "tools\新しい会社ぶんを作る.js"

   ── 設定ファイルから作る（聞かれずに一気に作る。AIに任せるときはこちら）──
     node "tools\新しい会社ぶんを作る.js" 設定.json
   設定.json の中身:
     {
       "companyId": "ebina",
       "companyName": "エビナ運送",
       "officeName": "",
       "managerEmails": ["shacho@example.com", "bantou@example.com"],
       "firebase": { "apiKey": "...", "authDomain": "...", "databaseURL": "...",
                     "projectId": "...", "storageBucket": "...",
                     "messagingSenderId": "...", "appId": "..." }
     }

   聞かれたことに答えると、template\ を元にして
     deploy\<会社ID>\  … その会社だけのアプリ一式
   が出来る。中身は index.html / sw.js / manifest.json / icons /
   firebase_rules.json / 導入手順.md の6つ。

   ── 既存アプリの載せ替え（データを引っ越さずに最新機能へ上げる）──
   companyId を "" にすると「会社の階層を作らない」形になり、データは users/<uid>/…
   のまま。すでに users/ 直下で動いているアプリ（北上さんの会社）はこちら。
   設定ファイルに "folder" を書くと、その名前のフォルダに出す。
     { "companyId": "", "folder": "kitakami", ... }

   Node の標準機能だけで動く（npm install 不要）。
   ══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'template');
const DEPLOY_DIR = path.join(ROOT, 'deploy');

const FB_KEYS = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const MAIL_RE = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

/* 複数行の貼り付けを受け取る。空行を1回入れたら終わり。 */
function askBlock(label) {
  console.log(label);
  console.log('（貼り付けたら、最後に空の行でEnter）');
  return new Promise((res) => {
    const lines = [];
    const onLine = (line) => {
      if (line.trim() === '' && lines.length > 0) {
        rl.removeListener('line', onLine);
        res(lines.join('\n'));
        return;
      }
      if (line.trim() !== '') lines.push(line);
    };
    rl.on('line', onLine);
  });
}

/* 貼り付けられた firebaseConfig から7項目を拾う */
function parseFirebaseConfig(text) {
  const out = {};
  for (const k of FB_KEYS) {
    const m = new RegExp(k + '\\s*:\\s*["\'`]([^"\'`]*)["\'`]').exec(text);
    if (m) out[k] = m[1];
  }
  return out;
}

/* 「a@x.com, b@y.com」でも配列でも受け取って、小文字・重複なしの配列にする。
   Firebase はメールを小文字で持つので、ここで揃えないとルールの照合が外れる。 */
function normalizeEmails(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,、\s]+/);
  const seen = [];
  for (const e of raw) {
    const v = String(e).trim().toLowerCase();
    if (v && seen.indexOf(v) < 0) seen.push(v);
  }
  return seen;
}

/* 置き換えたい値が本文に残っていないか（＝置換もれ）を確かめる */
function assertNoPlaceholder(file, text) {
  const left = text.match(/__[A-Z_]+__/g);
  if (left) {
    throw new Error(file + ' に置き換えられていない項目が残っています: ' + [...new Set(left)].join(', '));
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function fill(file, map) {
  let t = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(map)) t = t.split(k).join(v);
  assertNoPlaceholder(path.basename(file), t);
  fs.writeFileSync(file, t, 'utf8');
}

/* 実際に作る所（対話モードでも設定ファイルモードでも、最後はここを通る） */
function generate(companyId, companyName, officeName, managerEmails, fb, folder) {
  /* companyId が空 ＝「会社の階層を作らない」載せ替えモード。データは users/<uid>/… に入る */
  const rootMode = !companyId;
  const dirName = folder || companyId;
  if (!dirName) throw new Error('会社IDが空のときは、出力先フォルダ名(folder)を指定してください');
  const outDir = path.join(DEPLOY_DIR, dirName);
  const emails = normalizeEmails(managerEmails);
  if (!emails.length) throw new Error('まとめ役のメールアドレスが1つもありません');
  for (const e of emails) if (!MAIL_RE.test(e)) throw new Error('メールアドレスの形になっていません: ' + e);

  copyDir(TEMPLATE_DIR, outDir);

  /* 会社の階層あり／なしで、貼るルールが違う。使う方だけを firebase_rules.json として残す */
  const RULES_WITH = path.join(outDir, 'firebase_rules.json');
  const RULES_ROOT = path.join(outDir, 'firebase_rules_会社階層なし.json');
  if (rootMode) {
    fs.unlinkSync(RULES_WITH);
    fs.renameSync(RULES_ROOT, RULES_WITH);
  } else {
    fs.unlinkSync(RULES_ROOT);
  }

  const map = {
    '__COMPANY_ID__': companyId,
    '__COMPANY_NAME__': companyName,
    '__OFFICE_NAME__': officeName,
    /* index.html の TENANT.managerEmails に入る中身（例: "a@x.com", "b@y.com"） */
    '__MANAGER_EMAILS__': emails.map((e) => '"' + e + '"').join(', '),
    /* セキュリティルールの中の判定式。index.html と同じ顔ぶれになる */
    '__MANAGER_EMAIL_CHECK__': emails.map((e) => "auth.token.email === '" + e + "'").join(' || '),
    '__FB_API_KEY__': fb.apiKey,
    '__FB_AUTH_DOMAIN__': fb.authDomain,
    '__FB_DATABASE_URL__': fb.databaseURL,
    '__FB_PROJECT_ID__': fb.projectId,
    '__FB_STORAGE_BUCKET__': fb.storageBucket,
    '__FB_SENDER_ID__': fb.messagingSenderId,
    '__FB_APP_ID__': fb.appId
  };
  for (const f of ['index.html', 'manifest.json', 'firebase_rules.json']) {
    fill(path.join(outDir, f), map);
  }
  /* sw.js のキャッシュ名だけは、会社IDが空でも名前がぶつからないようフォルダ名を使う */
  fill(path.join(outDir, 'sw.js'), Object.assign({}, map, { '__COMPANY_ID__': dirName }));

  /* その会社ぶんの導入手順を書き出す */
  const pagesUrl = 'https://nylonman1109-prog.github.io/keikamotsu-app/deploy/' + dirName + '/';
  const mailList = emails.map((e) => '`' + e + '`').join(' ／ ');
  const guide = [
    '# ' + companyName + ' ぶん 導入手順',
    '',
    '作成日: ' + new Date().toISOString().slice(0, 10),
    '',
    '## この会社の設定',
    '',
    '| 項目 | 値 |',
    '|---|---|',
    '| 会社ID | ' + (rootMode ? '（なし＝会社の階層を作らない形）' : '`' + companyId + '`') + ' |',
    '| 会社名 | ' + companyName + ' |',
    '| 営業所名 | ' + (officeName || '（なし）') + ' |',
    '| まとめ役のメール（' + emails.length + '人） | ' + mailList + ' |',
    '| Firebaseプロジェクト | `' + fb.projectId + '` |',
    '| データの保存先 | `' + (rootMode ? 'users/<uid>/…' : 'companies/' + companyId + '/users/<uid>/…') + '` |',
    '| 配布URL（GitHub Pagesに置く場合） | ' + pagesUrl + ' |',
    '',
    '## 渡すまでの手順',
    '',
    '### 1. Firebase側の設定（Firebaseコンソール）',
    '',
    '- [ ] **Authentication** → ログイン方法 → **メール／パスワード** を有効にする',
    '- [ ] **Realtime Database** を作る（リージョンはどこでもよい。作成後のURLが上の databaseURL と一致すること）',
    '- [ ] **Realtime Database → ルール** に `firebase_rules.json` の中身を全部貼って「公開」'
      + (rootMode ? '（会社の階層を作らない版。`companies/` は許可していない）' : ''),
    '- [ ] **Authentication → 設定 → 承認済みドメイン** に、配布URLのドメインを追加',
    '      （GitHub Pagesなら `nylonman1109-prog.github.io`）',
    '',
    '### 2. アプリを置く',
    '',
    '- [ ] このフォルダ一式を配布先に置く（GitHub Pages / Firebase Hosting / 他）',
    '- [ ] 配布URLをブラウザで開いて、ログイン画面が出ることを確認',
    '',
    '### 3. まとめ役を作る（★ドライバーより先に）',
    '',
    'まとめ役に指定したアドレスは ' + emails.length + '件:',
    '',
    ...emails.map((e) => '- [ ] `' + e + '` で新規登録する → 自動で「まとめ役（承認済み）」になる'),
    '',
    '- [ ] まとめ役でログインして、ホームに「👥全員を見る」が出ることを確認',
    '- [ ] 設定画面で会社名・営業所名が正しいことを確認（違えばここで直せる）',
    '',
    '> ⚠️ **ドライバーより先にまとめ役を登録すること。**',
    '>    上のアドレスは、いつ登録しても自動でまとめ役になる（登録が遅れても大丈夫）。',
    '>    ただし **他人にそのアドレスで先に登録されると乗っ取られる** ので、渡したらすぐ登録してもらう。',
    '',
    '> まとめ役をあとから増やす／減らすのは、アプリの「👥全員を見る」から',
    '> 「👑 まとめ役にする」「まとめ役を外す」でできる（ファイルを直す必要はない）。',
    '> 会社をつくった1人目のまとめ役だけは外せない。',
    '',
    '### 4. ドライバーを入れる',
    '',
    '- [ ] ドライバーに配布URLを渡して、各自で新規登録してもらう',
    '- [ ] まとめ役が「👥全員を見る」から**承認**する（承認するまで何も保存できない）',
    '',
    '## 動作確認（渡す前に1回）',
    '',
    '- [ ] まとめ役でログイン → 点呼を1件保存できる',
    '- [ ] まとめ役が2人以上いるなら、2人目でもログインして「👥全員を見る」が出る',
    '- [ ] 別のアドレスで登録 → 「承認待ち」画面で止まる',
    '- [ ] まとめ役が承認 → そのアカウントで保存できるようになる',
    '- [ ] 帳票Excelを出して、ヘッダーに「' + companyName + (officeName ? '／' + officeName : '') + '」が入っている',
    '',
    '## お金の話（この会社が負担するもの）',
    '',
    '- **Firebase**: 無料枠（Sparkプラン）で始める。人数と記録が増えて枠を超えたら Blaze（従量課金）へ。',
    '  カード登録が要るので、**この会社の名義で契約してもらう**。',
    '- **レシートのAI読み取り（Gemini）**: 使う人が各自でAPIキーを取り、アプリの設定画面に入れる（端末に保存され、外には出ない）。',
    '- **承認依頼メールの自動送信（EmailJS）**: 使うならこの会社で登録して、`index.html` の `TENANT.emailjs` に入れる。',
    '  空のままでも「📧管理者に承認を依頼する」ボタン（手動送信）は動く。',
    '',
    '## 直すとき',
    '',
    '- 会社ごとの設定は `index.html` のいちばん上の **TENANT ブロック**だけ。それ以外は全社共通。',
    '- **まとめ役のメールを増減したら、`firebase_rules.json` も貼り直すこと。** 片方だけ直しても効かない。',
    '  （生成スクリプトを回し直せば両方そろう）',
    '- 機能を直すときは `template\\` を直してから、この会社ぶんを作り直す（設定は聞き直せばよい）。',
    '- アプリを更新したら `sw.js` の `CACHE_VERSION` の `v1` を `v2`, `v3`… と上げること。',
    '  上げ忘れるとドライバーのスマホに更新が届かない。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(outDir, '導入手順.md'), guide, 'utf8');

  console.log('');
  console.log('✅ できました: ' + outDir);
  console.log('');
  console.log('   まとめ役（' + emails.length + '人）: ' + emails.join(' / '));
  console.log('');
  console.log('   index.html          … アプリ本体（TENANTブロックに設定済み）');
  console.log('   sw.js / manifest.json / icons  … スマホのホーム画面に置くための一式');
  console.log('   firebase_rules.json … Firebaseコンソールのルールに貼るもの');
  console.log('   導入手順.md         … 渡すまでの手順（これを見ながら進める）');
  console.log('');
  console.log('次の一手 → deploy\\' + dirName + '\\導入手順.md を開く');
  console.log('');
  return outDir;
}

/* 設定ファイルから一気に作る（対話なし） */
function buildFromConfig(cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const mails = cfg.managerEmails || cfg.managerEmail;
  if (cfg.companyId === undefined) throw new Error('設定ファイルに companyId がありません（載せ替えなら "" と書く）');
  if (!cfg.companyName) throw new Error('設定ファイルに companyName がありません');
  if (!mails) throw new Error('設定ファイルに managerEmails がありません');
  if (!cfg.firebase) throw new Error('設定ファイルに firebase がありません');
  for (const k of FB_KEYS) if (!cfg.firebase[k]) throw new Error('設定ファイルの firebase に ' + k + ' がありません');
  if (cfg.companyId !== '' && !/^[a-z0-9][a-z0-9-]{1,30}$/.test(cfg.companyId)) throw new Error('companyId は英小文字・数字・ハイフンで2文字以上にしてください（載せ替えなら ""）');
  if (cfg.companyId === '' && !cfg.folder) throw new Error('companyId が "" のときは folder（出力先フォルダ名）も書いてください');
  return generate(cfg.companyId, cfg.companyName, cfg.officeName || '', mails, cfg.firebase, cfg.folder);
}

(async () => {
  try {
    if (process.argv[2]) {
      const p = path.resolve(process.argv[2]);
      console.log('');
      console.log('═══ 設定ファイルから作ります: ' + p + ' ═══');
      buildFromConfig(p);
      rl.close();
      return;
    }

    console.log('');
    console.log('═══ 新しい会社ぶんのアプリを作ります ═══');
    console.log('');

    if (!fs.existsSync(TEMPLATE_DIR)) throw new Error('template\\ が見つかりません: ' + TEMPLATE_DIR);

    /* ── 1. 会社ID ── */
    let companyId = null;
    let folder = '';
    while (companyId === null) {
      const v = (await ask('会社ID（英小文字・数字・ハイフン。例: ebina／既存アプリの載せ替えなら空でEnter）: ')).toLowerCase();
      if (v === '') {
        console.log('');
        console.log('  会社IDなし＝「会社の階層を作らない」形です。データは users/<uid>/… に入ります。');
        console.log('  すでに users/ 直下で動いているアプリを、データを引っ越さずに載せ替えるとき用です。');
        console.log('  ★新しい会社の場合はここを空にしないでください。');
        const yn = await ask('  既存アプリの載せ替えですか？ (yes/no): ');
        if (yn.toLowerCase() !== 'yes') continue;
        while (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(folder)) {
          folder = (await ask('  出力先フォルダ名（例: kitakami）: ')).toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(folder)) console.log('    → 英小文字・数字・ハイフンで2文字以上にしてください');
        }
        companyId = '';
      } else if (/^[a-z0-9][a-z0-9-]{1,30}$/.test(v)) {
        companyId = v;
        folder = v;
      } else {
        console.log('  → 英小文字・数字・ハイフンで2文字以上にしてください');
      }
    }

    const outDir = path.join(DEPLOY_DIR, folder);
    if (fs.existsSync(outDir)) {
      const yn = await ask('⚠️ deploy\\' + folder + '\\ は既にあります。中身を上書きしますか？ (yes/no): ');
      if (yn.toLowerCase() !== 'yes') { console.log('やめました。何も変えていません。'); rl.close(); return; }
    }

    /* ── 2. 会社名・営業所名 ── */
    let companyName = '';
    while (!companyName) companyName = await ask('会社名（帳票の見出しに出る。例: エビナ運送）: ');
    const officeName = await ask('営業所名（任意。無ければEnter）: ');

    /* ── 3. まとめ役のメール（複数可） ── */
    let emails = [];
    while (!emails.length) {
      console.log('');
      console.log('まとめ役のメールアドレス。★複数入れられます（カンマ区切り）');
      console.log('  ここに書いた人は、そのアドレスで登録するだけで自動的にまとめ役になります。');
      console.log('  例）shacho@example.com, bantou@example.com');
      const line = await ask('まとめ役のメール: ');
      emails = normalizeEmails(line);
      const bad = emails.filter((e) => !MAIL_RE.test(e));
      if (!emails.length) console.log('  → 1つ以上入れてください');
      else if (bad.length) { console.log('  → メールアドレスの形になっていません: ' + bad.join(', ')); emails = []; }
      else console.log('  → ' + emails.length + '人をまとめ役にします: ' + emails.join(' / '));
    }

    /* ── 4. Firebase の設定 ── */
    console.log('');
    const raw = await askBlock('Firebaseの接続情報を貼り付けてください（コンソール → ⚙️プロジェクトの設定 → マイアプリ → SDKの設定と構成）:');
    const fb = parseFirebaseConfig(raw);
    const missing = FB_KEYS.filter((k) => !fb[k]);
    if (missing.length) {
      console.log('');
      console.log('⚠️ 拾えなかった項目があります。1つずつ入れてください: ' + missing.join(', '));
      for (const k of missing) {
        let v = '';
        while (!v) v = await ask('  ' + k + ': ');
        fb[k] = v;
      }
    }
    if (!/^https:\/\/.+firebasedatabase\.app|^https:\/\/.+firebaseio\.com/.test(fb.databaseURL)) {
      console.log('');
      console.log('⚠️ databaseURL が Realtime Database のものに見えません: ' + fb.databaseURL);
      console.log('   （このアプリは Firestore ではなく Realtime Database を使います）');
      const yn = await ask('   このまま進めますか？ (yes/no): ');
      if (yn.toLowerCase() !== 'yes') { console.log('やめました。'); rl.close(); return; }
    }

    /* ── 5. 生成して、その会社ぶんの導入手順を書き出す ── */
    generate(companyId, companyName, officeName, emails, fb, folder);
  } catch (e) {
    console.error('');
    console.error('❌ 失敗しました: ' + e.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
})();
