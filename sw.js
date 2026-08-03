// 軽貨物まるごとアプリ Service Worker
// 方針: アプリの「外枠」(HTML本体・manifest・アイコン)だけをキャッシュして
//       2回目以降の起動を速くする。Firebase(認証・Realtime Database)への通信や
//       外部CDN(firebasejs SDK)は一切キャッシュせず、常にネットワークへ流す。
//       → 古いデータが表示される事故を防ぐため。

// バージョンを上げると古いキャッシュが自動で破棄される(下のactivate参照)。
// ★本番にリリースするたびに、この番号を必ず上げること(上げ忘れると同僚のスマホに更新が配られない)。
var CACHE_VERSION = 'keikamotsu-shell-v6';

// self.location基準の相対パス解決。GitHub Pagesのサブパス(/keikamotsu-app/)配下でも
// ローカル直下でも、そのままの相対位置を指すようにする。
var SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
].map(function (p) { return new URL(p, self.location).href; });

self.addEventListener('install', function (event) {
  // ここで自動skipWaitingはしない。新しいSWは一旦「waiting(待機中)」で止め、
  // 画面側の「新しいバージョンがあります」帯をユーザーがタップしたときだけ
  // 有効化する(入力中のデータを消さないため)。
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_URLS);
    })
  );
});

// 画面側(index.html)から「更新するボタンが押された」メッセージを受け取ったら、
// 待機中のこのSWを有効化する。
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name.indexOf('keikamotsu-shell-') === 0 && name !== CACHE_VERSION; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // GET以外(POST等)には一切関与しない。
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // 自サイト(同一オリジン)の「外枠」ファイルだけを対象にする。
  // それ以外(Firebase Auth/Realtime Database通信、gstatic上のfirebasejs SDKなど)は
  // ここで何もしない = ブラウザ標準の処理(常にネットワーク)に任せる。
  var isShellFile = SHELL_URLS.indexOf(url.href) !== -1;

  if (!isShellFile) return;

  // 外枠ファイルは cache-first、裏でネットワークからも更新しておく(stale-while-revalidate)。
  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(req).then(function (res) {
        if (res && res.ok) {
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, res.clone()); });
        }
        return res;
      }).catch(function () {
        return cached; // オフライン時はキャッシュのみ
      });
      return cached || networkFetch;
    })
  );
});
