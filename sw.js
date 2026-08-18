// 軽貨物まるごとアプリ Service Worker
// 方針: アプリの「外枠」(HTML本体・manifest・アイコン)だけをキャッシュする。
//       Firebase(認証・Realtime Database)への通信や外部CDN(firebasejs SDK)は
//       一切キャッシュせず、常にネットワークへ流す(古いデータ表示の事故を防ぐため)。
//
// ★HTML本体だけは「ネット優先(network-first)」にしている(2026-08-19 変更)。
//   以前は cache-first だったため、更新しても端末に保存された古い画面が出続け、
//   「更新する」帯を押すまで新しくならない＝直したはずの修正が反映されない、という
//   分かりにくい状態になっていた。
//   今は回線があれば毎回サーバーの最新HTMLを取りに行き、遅い/圏外のときだけ
//   キャッシュを使う。アイコンやmanifestは中身が変わらないので従来どおりキャッシュ優先。

// バージョンを上げると古いキャッシュが自動で破棄される(下のactivate参照)。
// ★本番にリリースするたびに、この番号を必ず上げること(上げ忘れると同僚のスマホに更新が配られない)。
var CACHE_VERSION = 'keikamotsu-shell-v11';

// ネットが遅いときに何秒待つか。これを過ぎたらキャッシュの画面を出して待たせない。
var HTML_NETWORK_TIMEOUT_MS = 3000;

// self.location基準の相対パス解決。GitHub Pagesのサブパス(/keikamotsu-app/)配下でも
// ローカル直下でも、そのままの相対位置を指すようにする。
function abs(p) { return new URL(p, self.location).href; }

// HTML本体(= 毎回最新を取りに行くもの)
var HTML_URLS = ['./', './index.html'].map(abs);
// 変わらない添え物(= キャッシュ優先でよいもの)
var ASSET_URLS = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
].map(abs);
var SHELL_URLS = HTML_URLS.concat(ASSET_URLS);

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

// HTML本体: ネット優先。取れたらキャッシュも更新しておく。
// 遅い(3秒超)/圏外のときだけキャッシュを出す。
function htmlNetworkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    function fromCache(fallbackMsg) {
      caches.match(req).then(function (cached) {
        if (settled) return;
        settled = true;
        resolve(cached || new Response(
          '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">' + fallbackMsg + '</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        ));
      });
    }
    var timer = setTimeout(function () { fromCache('通信が不安定です。電波の良い場所で開き直してください。'); }, HTML_NETWORK_TIMEOUT_MS);

    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
      }
      if (settled) return;      // 既にキャッシュを返した後なら、裏でキャッシュだけ更新して終わり
      settled = true;
      clearTimeout(timer);
      resolve(res);
    }).catch(function () {
      clearTimeout(timer);
      fromCache('オフラインです。電波が入る場所で開き直してください。');
    });
  });
}

// アイコン・manifest: キャッシュ優先＋裏で更新(従来どおり)
function assetCacheFirst(req) {
  return caches.match(req).then(function (cached) {
    var networkFetch = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return cached; // オフライン時はキャッシュのみ
    });
    return cached || networkFetch;
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // GET以外(POST等)には一切関与しない。
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // 自サイト(同一オリジン)の「外枠」ファイルだけを対象にする。
  // それ以外(Firebase Auth/Realtime Database通信、gstatic上のfirebasejs SDKなど)は
  // ここで何もしない = ブラウザ標準の処理(常にネットワーク)に任せる。
  if (SHELL_URLS.indexOf(url.href) === -1) return;

  if (HTML_URLS.indexOf(url.href) !== -1) {
    event.respondWith(htmlNetworkFirst(req));
  } else {
    event.respondWith(assetCacheFirst(req));
  }
});
