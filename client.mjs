// client.mjs — AI 推荐音乐。
//
// 职责分工：
//   - 这里（渲染进程）：记录听歌历史（playback 事件 + storage）、注册设置与首页
//     标签页、把听歌档案交给 main、拿到 AI 的推荐清单后在 Omni 里搜索匹配，
//     变成可播放的曲目（omni.searchSongs → playback.playSong/enqueue）。
//   - main.cjs（主进程）：调 OpenAI 兼容接口拿推荐，密钥走 Folium 的 secret
//     设置，从不过 IPC。
//
// 用到的宿主接口全部是 Folium 1.7 的公开成员：storage、events、playback
// （playSong/enqueue，权限 playback.control）、omni（免权限）、registries
// （settingsSections/homeTabs/commands）、ui（toast/icon/openHomeTab）、rpc。
// 不读宿主内部状态，不碰 localStorage。

const MINOR_REQUIRED = 7;       // 需要 Folium 1.7（Folia 0.7.22 起：secrets / rpc / openHomeTab）
const PLAY_MIN_MS = 30000;      // 一首歌听满这么久才算一次有效播放
const HISTORY_KEY = 'history-v1';
const RESULTS_KEY = 'results-v1';
const HISTORY_CAP = 600;        // 记录的歌数上限（storage 配额 1MB，绰绰有余）
const RECENT_CAP = 80;          // 最近播放环形缓冲
const SEARCH_LIMIT = 15;        // 每条推荐在音源里搜几条候选(热门歌翻唱多,候选太窄会错过指定歌手的版本)
const RESOLVE_POOL = 4;         // 并发搜索数（omni 限额：每模组 120 次/分、并发 8）
const CLEAR_ARM_MS = 4000;      // 「清除历史」两次点击的确认窗口
const RESULTS_CAP = 60;         // 推荐列表在页面上保留的最大行数（电台追加会不断变长）
const RADIO_RUNWAY_MIN = 2;     // 队列里当前歌之后不足这个数就开始补充下一批
const RADIO_COOLDOWN_MS = 60000; // 一批补充颗粒无收时的冷却

const say = {
  needUrl: '先在模组设置里填写 OpenAI 兼容接口地址',
  needKey: '先在模组设置里填写 API 密钥（加密保存在本机）',
  generating: '正在让 AI 挑歌…',
  generated: (n) => `AI 推荐了 ${n} 首歌，正在音源里搜索匹配…`,
  generateFailed: '生成推荐失败',
  noSongs: 'AI 没有给出可用的推荐',
  noSource: '没有可用的在线音源，无法把推荐匹配成可播放的歌；请在 Folia 里配置/登录一个音源',
  cleared: '已清除听歌记录',
  clearConfirm: '再点一次确认清除',
  enqueued: (n) => `已把 ${n} 首推荐加入队列`,
};

const explainOmniError = (error) => {
  const code = error?.code ?? error?.message ?? '';
  const text = String(code);
  if (text.includes('rate-limited')) return '搜索太频繁，稍后再试';
  if (text.includes('unsupported') || text.includes('endpoint-denied')) return '当前音源不支持搜索';
  if (text.includes('account-changed') || text.includes('auth') || text.includes('sign-in')) return '音源需要先登录';
  if (text.includes('aborted')) return '已取消';
  return text.slice(0, 80) || '搜索失败';
};

/* 提示文案：模组面板的注册项用双语对象；页面内容按宿主语言取一份。 */
const T = (zh, en) => ({ 'zh-CN': zh, en });

export default function activate(folium) {
  // 老宿主上什么都不注册，免得装出一个按了没反应的模组。
  const major = Number(folium.host?.folium?.major ?? 1);
  const minor = Number(folium.host?.folium?.minor ?? 0);
  if (major !== 1 || minor < MINOR_REQUIRED) {
    folium.log?.warn?.(`AI 推荐音乐需要 Folium 1.${MINOR_REQUIRED} 以上（当前 ${major}.${minor}），已跳过激活`);
    return () => {};
  }

  const playback = folium.playback;
  const log = folium.log ?? console;
  let disposed = false;
  let currentLang = 'zh-CN';

  // ---------------------------------------------------------------- 通用

  const toast = (message, type = 'info') => {
    try { folium.ui.toast(message, { type }); } catch { /* 导出窗口里没有 toast */ }
  };

  const localeOf = () => {
    try { return String(folium.ui?.locale ?? '') || currentLang; } catch { return currentLang; }
  };

  /** 双语文案按当前语言取（注册项的 label 走宿主的本地化，不走这里）。 */
  const tr = (zh, en) => {
    const lang = localeOf();
    return /en/i.test(lang) ? en : zh;
  };

  const keyOf = (song) => `${String(song?.source ?? '')}\u0000${String(song?.id ?? '')}`;

  const songSnapshot = (song) => ({
    id: String(song?.id ?? ''),
    source: String(song?.source ?? ''),
    title: String(song?.title ?? '').slice(0, 200),
    artist: String(song?.artist ?? '').slice(0, 200),
    album: String(song?.album ?? '').slice(0, 200),
  });

  const splitArtists = (artist) => String(artist ?? '')
    .split(/\s*[/&、,，;；]\s*/)
    .map((name) => name.trim())
    .filter(Boolean);

  // ---------------------------------------------------------------- 听歌历史

  let history = { v: 1, songs: {}, recent: [] };
  let saveTimer = null;

  const normalizeHistory = (raw) => {
    const songs = {};
    const source = raw?.songs && typeof raw.songs === 'object' && !Array.isArray(raw.songs) ? raw.songs : {};
    for (const [key, entry] of Object.entries(source)) {
      if (!entry || typeof entry !== 'object' || !entry.t) continue;
      songs[key] = {
        t: String(entry.t).slice(0, 200),
        a: String(entry.a ?? ''),
        al: String(entry.al ?? ''),
        s: String(entry.s ?? ''),
        p: Number.isFinite(entry.p) ? Math.max(0, Math.round(entry.p)) : 0,
        q: Number.isFinite(entry.q) ? Math.max(0, Math.round(entry.q)) : 0,
        last: Number.isFinite(entry.last) ? entry.last : 0,
      };
    }
    const recentRaw = Array.isArray(raw?.recent) ? raw.recent : [];
    const recent = [];
    for (const entry of recentRaw) {
      if (!entry || typeof entry !== 'object' || !entry.t) continue;
      recent.push({
        t: String(entry.t).slice(0, 200),
        a: String(entry.a ?? ''),
        al: String(entry.al ?? ''),
        at: Number.isFinite(entry.at) ? entry.at : 0,
      });
      if (recent.length >= RECENT_CAP) break;
    }
    return { v: 1, songs, recent };
  };

  const trimHistory = () => {
    const entries = Object.entries(history.songs);
    if (entries.length <= HISTORY_CAP) return;
    entries.sort(([, x], [, y]) => (y.last - x.last) || (y.p - x.p));
    const kept = entries.slice(0, HISTORY_CAP);
    history.songs = Object.fromEntries(kept);
  };

  const loadHistory = async () => {
    try {
      const raw = await folium.storage.get(HISTORY_KEY);
      if (raw && typeof raw === 'object') history = normalizeHistory(raw);
    } catch (error) {
      log.warn?.('读取听歌历史失败', error);
    }
  };

  const saveHistoryNow = async () => {
    try { await folium.storage.set(HISTORY_KEY, history); } catch (error) { log.warn?.('听歌历史没写进去', error); }
  };

  const scheduleSave = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveHistoryNow();
    }, 1500);
  };

  /** 「记录听歌历史」关掉时：不记新的播放与跳过（已有记录仍会进档案）。 */
  const trackingEnabled = () => {
    try { return readSettings().trackHistory; } catch { return true; }
  };

  const recordPlay = (song) => {
    if (!trackingEnabled()) return;
    const key = keyOf(song);
    if (!key.trim()) return;
    const entry = history.songs[key] ?? {
      t: song.title, a: song.artist, al: song.album, s: song.source, p: 0, q: 0, last: 0,
    };
    entry.p += 1;
    entry.last = Date.now();
    history.songs[key] = entry;
    // 最近播放：同一首连播只更新时间戳。
    const head = history.recent[0];
    if (head && head.t === entry.t && head.a === entry.a) {
      head.at = entry.last;
    } else {
      history.recent.unshift({ t: entry.t, a: entry.a, al: entry.al, at: entry.last });
      if (history.recent.length > RECENT_CAP) history.recent.length = RECENT_CAP;
    }
    trimHistory();
    scheduleSave();
    render();
  };

  const recordSkip = (song) => {
    if (!trackingEnabled()) return;
    const key = keyOf(song);
    if (!key.trim()) return;
    const entry = history.songs[key] ?? {
      t: song.title, a: song.artist, al: song.album, s: song.source, p: 0, q: 0, last: 0,
    };
    entry.q += 1;
    history.songs[key] = entry;
    scheduleSave();
  };

  // ---------------------------------------------------------------- 播放追踪

  /** 当前歌的追踪槽：`counted` 之后这首歌在这台机器上的播放已记过一次。 */
  let current = null;

  const isPlaying = () => {
    try { return playback.getState()?.state === 'playing'; } catch { return false; }
  };

  const finalizeCurrent = () => {
    if (!current) return;
    if (!current.counted) {
      const elapsed = Date.now() - current.since;
      if (elapsed >= PLAY_MIN_MS) recordPlay(current.dto);
      else recordSkip(current.dto);
    }
    current = null;
  };

  const onSongChanged = () => {
    finalizeCurrent();
    const song = (() => { try { return playback.getState()?.song ?? null; } catch { return null; } })();
    if (!song || !song.ref) { current = null; radioTick(); return; }
    const dto = songSnapshot(song);
    current = { key: keyOf(dto), dto, since: Date.now(), counted: false };
    // 换歌即检查电台跑道：歌与歌的间隙是补充下一批的最佳时机。
    radioTick();
  };

  const tickPlayback = () => {
    if (!current || current.counted) return;
    if (Date.now() - current.since >= PLAY_MIN_MS && isPlaying()) {
      recordPlay(current.dto);
      current.counted = true;
    }
  };

  // ---------------------------------------------------------------- 设置

  const settingsSection = folium.registries.settingsSections.register({
    id: 'recommend',
    label: T('AI 推荐音乐', 'AI music recommendations'),
    description: T(
      '用 OpenAI 兼容接口，根据你平时的听歌记录推荐新歌。接口地址与密钥填在这里，不读取 Folia 自己的 AI 设置。',
      'Recommends songs from an OpenAI-compatible endpoint based on your listening history. The endpoint and key live here; Folia’s own AI settings are not read.',
    ),
    settings: [
      {
        key: 'apiUrl',
        type: 'text',
        label: T('接口地址', 'API base URL'),
        description: T(
          'OpenAI 兼容接口。填 https://host 或 https://host/v1 都可以，会自动补 /chat/completions。',
          'An OpenAI-compatible endpoint; /chat/completions is appended automatically.',
        ),
        defaultValue: '',
      },
      {
        key: 'model',
        type: 'text',
        label: T('模型', 'Model'),
        description: T('要使用的模型名，例如 gpt-4o-mini、deepseek-chat。', 'Model name to call.'),
        defaultValue: 'gpt-4o-mini',
      },
      {
        key: 'apiKey',
        type: 'secret',
        label: T('API 密钥', 'API key'),
        description: T('只保存在本机，由系统加密存放。', 'Stored on this machine only, sealed by the OS.'),
      },
      {
        key: 'temperature',
        type: 'number',
        label: T('温度', 'Temperature'),
        description: T('越高越敢推。0.8 左右比较合适。', 'Higher is more adventurous; around 0.8 works well.'),
        defaultValue: 0.8,
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'recommendCount',
        type: 'number',
        label: T('每次推荐数量', 'Songs per batch'),
        defaultValue: 8,
        min: 3,
        max: 20,
        step: 1,
      },
      {
        key: 'autoEnqueue',
        type: 'boolean',
        label: T('搜索到后自动加入队列', 'Auto enqueue matched songs'),
        description: T(
          '开着时：推荐在音源里匹配成功就自动接在当前队列后面（队列空着就直接开始播放）。',
          'When on, matched songs are appended to the queue (or start playing if the queue is empty).',
        ),
        defaultValue: false,
      },
      {
        key: 'userNote',
        type: 'text',
        label: T('额外偏好（可选）', 'Preference hint (optional)'),
        description: T('例如「多来点日语歌」「最近想听安静的」，会一并交给 AI。', 'For example “more Japanese songs”, “calm for now”.'),
        defaultValue: '',
      },
      {
        key: 'useArchive',
        type: 'boolean',
        label: T('联动「听歌档案」', 'Link with Listening Archive'),
        description: T(
          '检测到官方「听歌档案」模组的记录时，优先用它的长期听歌数据生成推荐（本模组自己的记录会合并进去，不会重复入账）。',
          'When the official Listening Archive mod has records, they feed the recommendations (merged with this mod’s own records).',
        ),
        defaultValue: true,
      },
      {
        key: 'trackHistory',
        type: 'boolean',
        label: T('记录我的听歌历史', 'Track my listening history'),
        description: T(
          '推荐完全依赖这份记录。关掉后不再记录新的播放（已有记录仍会被读取）。',
          'Recommendations are built on this record. When off, new plays are not recorded (existing data is still read).',
        ),
        defaultValue: true,
      },
    ],
  });

  const readSettings = () => {
    try {
      const values = settingsSection.settings.get() ?? {};
      return {
        apiUrl: String(values.apiUrl ?? '').trim(),
        model: String(values.model ?? '').trim(),
        temperature: Number(values.temperature),
        recommendCount: Math.round(Number(values.recommendCount)),
        autoEnqueue: values.autoEnqueue === true,
        userNote: String(values.userNote ?? '').trim(),
        useArchive: values.useArchive !== false,
        trackHistory: values.trackHistory !== false,
      };
    } catch {
      return { apiUrl: '', model: '', temperature: 0.8, recommendCount: 8, autoEnqueue: false, userNote: '', useArchive: true, trackHistory: true };
    }
  };

  const hasKey = async () => {
    try { return (await folium.secrets.has('apiKey')) === true; } catch { return false; }
  };

  // ---------------------------------------------------------------- 听歌档案

  /** 「听歌档案」联动状态：null=还没查过；否则是 main 返回的 profile。 */
  let archiveProfile = null;
  let archiveStatusKnown = false;

  const refreshArchive = async () => {
    try {
      archiveProfile = await folium.rpc.call('archiveProfile');
      archiveStatusKnown = true;
    } catch (error) {
      // 读不到就静默退回本模组自己的记录：联动是增强，不是依赖。
      archiveProfile = null;
      archiveStatusKnown = false;
      log.warn?.('读取「听歌档案」记录失败', error);
    }
  };

  const archiveLinked = () => {
    try { return readSettings().useArchive; } catch { return true; }
  };

  /** 本模组自己记录的口味档案（客户端追踪的那份）。 */
  const buildOwnDigest = () => {
    const songs = Object.values(history.songs);
    const totalPlays = songs.reduce((sum, s) => sum + s.p, 0);
    if (songs.length === 0) {
      return { empty: true, trackedSongs: 0, totalPlays: 0, topArtists: [], topSongs: [], recent: [], skips: [] };
    }
    const artistAgg = new Map();
    for (const song of songs) {
      for (const name of splitArtists(song.a)) {
        artistAgg.set(name, (artistAgg.get(name) ?? 0) + song.p);
      }
    }
    const topArtists = [...artistAgg.entries()]
      .filter(([, plays]) => plays > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 12)
      .map(([name, plays]) => ({ name, plays }));
    const topSongs = songs
      .filter((s) => s.p > 0)
      .sort((x, y) => (y.p - x.p) || (y.last - x.last))
      .slice(0, 15)
      .map((s) => ({ t: s.t, a: s.a, p: s.p }));
    const recent = history.recent.slice(0, 25).map((r) => ({ t: r.t, a: r.a }));
    const skips = songs
      .filter((s) => s.q >= 2 && s.p === 0)
      .sort((x, y) => y.q - x.q)
      .slice(0, 8)
      .map((s) => ({ t: s.t, a: s.a, q: s.q }));
    return {
      empty: topArtists.length === 0 && topSongs.length === 0 && recent.length === 0,
      trackedSongs: songs.length,
      totalPlays,
      topArtists,
      topSongs,
      recent,
      skips,
    };
  };

  /** 合并「听歌档案」的长期记录与本模组自己的记录。两边对同一首歌的播放
   *  会各自计一次（自有记录是安装本模组之后的子集），对口味排序几乎没有
   *  影响，换来的是任何一边缺席时另一边仍完整可用。 */
  const mergeDigests = (own, archive) => {
    const artistMap = new Map();
    for (const artist of own.topArtists ?? []) artistMap.set(artist.name, (artistMap.get(artist.name) ?? 0) + artist.plays);
    for (const artist of archive.topArtists ?? []) artistMap.set(artist.name, (artistMap.get(artist.name) ?? 0) + artist.plays);
    const topArtists = [...artistMap.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 12)
      .map(([name, plays]) => ({ name, plays }));

    const songMap = new Map();
    for (const song of own.topSongs ?? []) songMap.set(`${song.t}\u0000${song.a}`, { ...song });
    for (const song of archive.topSongs ?? []) {
      const key = `${song.t}\u0000${song.a}`;
      const existing = songMap.get(key);
      songMap.set(key, existing ? { ...existing, p: existing.p + song.p } : { ...song });
    }
    const topSongs = [...songMap.values()].sort((x, y) => y.p - x.p).slice(0, 15);

    const seenRecent = new Set();
    const recent = [];
    for (const entry of [...(own.recent ?? []), ...(archive.recent ?? [])]) {
      const key = `${entry.t}\u0000${entry.a}`;
      if (seenRecent.has(key)) continue;
      seenRecent.add(key);
      recent.push(entry);
      if (recent.length >= 25) break;
    }

    const skipMap = new Map();
    for (const skip of own.skips ?? []) skipMap.set(`${skip.t}\u0000${skip.a}`, (skipMap.get(`${skip.t}\u0000${skip.a}`) ?? 0) + skip.q);
    for (const skip of archive.skips ?? []) skipMap.set(`${skip.t}\u0000${skip.a}`, (skipMap.get(`${skip.t}\u0000${skip.a}`) ?? 0) + skip.q);
    const skips = [...skipMap.entries()]
      .map(([key, q]) => {
        const [t, a] = key.split('\u0000');
        return { t, a, q };
      })
      .sort((x, y) => y.q - x.q)
      .slice(0, 8);

    return {
      empty: topArtists.length === 0 && topSongs.length === 0 && recent.length === 0,
      trackedSongs: (own.trackedSongs ?? 0) + (archive.songs ?? 0),
      totalPlays: (own.totalPlays ?? 0) + (archive.plays ?? 0),
      topArtists,
      topSongs,
      recent,
      skips,
      archive: { sessions: archive.sessions ?? 0, songs: archive.songs ?? 0 },
    };
  };

  const buildDigest = () => {
    const own = buildOwnDigest();
    if (!archiveLinked() || archiveProfile?.status !== 'linked') return own;
    return mergeDigests(own, archiveProfile);
  };

  // ---------------------------------------------------------------- 结果状态

  /** results 的行：{title, artist, reason, status, song, error, enqueued}
   *  status: pending | searching | found | missing | error */
  let results = [];
  let busy = false;
  let statusText = '';
  let resolvedThisSession = false;
  let clearArmedAt = 0;
  let keyKnown = null;          // null=还没查过；true/false=密钥是否已配置（缓存，避免每次重绘都发 IPC）

  const refreshKeyStatus = async () => {
    keyKnown = await hasKey();
    render();
  };

  const loadResults = async () => {
    try {
      const raw = await folium.storage.get(RESULTS_KEY);
      if (Array.isArray(raw?.rows)) {
        results = raw.rows
          .filter((row) => row && typeof row === 'object' && row.title)
          .slice(0, 40)
          .map((row) => ({
            title: String(row.title).slice(0, 200),
            artist: String(row.artist ?? ''),
            reason: String(row.reason ?? ''),
            status: 'pending',
            song: null,
            error: '',
            enqueued: false,
            mismatch: false,
          }));
      }
    } catch { /* 没有上次的结果就算了 */ }
  };

  const saveResults = async () => {
    const rows = results.map((row) => ({ title: row.title, artist: row.artist, reason: row.reason }));
    try { await folium.storage.set(RESULTS_KEY, { v: 1, rows }); } catch { /* 配额之类的意外，不值得打扰用户 */ }
  };

  // ---------------------------------------------------------------- 匹配

  const cleanName = (value) => String(value ?? '')
    .toLowerCase()
    .replace(/[(（\[【{].*?[)）\]】}]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

  const bigramsOf = (text) => {
    const grams = new Map();
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };

  const diceOf = (x, y) => {
    if (!x || !y) return 0;
    if (x === y) return 1;
    const a = bigramsOf(x);
    const b = bigramsOf(y);
    let overlap = 0;
    for (const [gram, count] of a) {
      const other = b.get(gram);
      if (other) overlap += Math.min(count, other);
    }
    const total = (x.length - 1) + (y.length - 1);
    return total > 0 ? (2 * overlap) / total : 0;
  };

  const titleScoreOf = (expect, got) => {
    const x = cleanName(expect);
    const y = cleanName(got);
    if (!x || !y) return 0;
    if (x === y) return 100;
    if (x.length >= 2 && y.length >= 2 && (y.includes(x) || x.includes(y))) return 76;
    return Math.round(diceOf(x, y) * 65);
  };

  const artistScoreOf = (expect, got) => {
    const expected = splitArtists(expect).map(cleanName).filter(Boolean);
    const gots = splitArtists(got).map(cleanName).filter(Boolean);
    if (expected.length === 0 || gots.length === 0) return 0;
    let best = 0;
    for (const x of expected) {
      for (const y of gots) {
        if (x === y) return 30;
        if (x.length >= 2 && y.length >= 2 && (y.includes(x) || x.includes(y))) best = Math.max(best, 20);
        else if (diceOf(x, y) >= 0.8) best = Math.max(best, 16);
      }
    }
    return best;
  };

  /** 有的模型把「歌手 - 歌名」塞进 title：歌手为空时先拆一下。 */
  const splitDashTitle = (row) => {
    if (row.artist) return;
    const match = /^(.{1,60})\s+[-—–]\s+(.{1,80})$/.exec(row.title);
    if (match) {
      row.artist = match[1].trim();
      row.title = match[2].trim();
    }
  };

  const pickBest = (items, title, artist) => {
    let best = null;
    let bestScore = 0;
    for (const item of items) {
      if (!item?.ref) continue;
      const tScore = titleScoreOf(title, item.title ?? '');
      const aScore = artistScoreOf(artist, item.artist ?? '');
      const score = tScore + aScore;
      const acceptable = tScore >= 70 || (tScore >= 40 && aScore >= 20) || (tScore >= 30 && aScore >= 30);
      if (acceptable && score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  };

  /** 简单的并发池，避免把 omni 的并发闸门顶满。 */
  const createPool = (size) => {
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < size && queue.length > 0) {
        const task = queue.shift();
        active += 1;
        void Promise.resolve()
          .then(task)
          .catch(() => {})
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    return {
      run(task) {
        return new Promise((resolve) => {
          queue.push(() => Promise.resolve(task()).then(resolve, resolve));
          pump();
        });
      },
    };
  };

  const searchOne = async (row) => {
    row.status = 'searching';
    row.error = '';
    row.mismatch = false;
    render();
    const query = `${row.title} ${row.artist}`.trim();
    try {
      const answer = await folium.omni.searchSongs(query, { limit: SEARCH_LIMIT });
      const items = Array.isArray(answer?.items) ? answer.items : [];
      const best = pickBest(items, row.title, row.artist);
      if (best) {
        row.status = 'found';
        row.song = best;
        /* 歌手完全对不上：热门歌的翻唱版本被搜到了、但指定歌手的版本不在
         * 结果里。照旧可播放，但标记出来——展示真实匹配到的歌，且自动入队
         * 跳过它，不让封面版悄悄混进队列。 */
        row.mismatch = Boolean(row.artist) && artistScoreOf(row.artist, best.artist ?? '') === 0;
      } else {
        row.status = 'missing';
        row.error = '';
      }
    } catch (error) {
      row.status = 'error';
      row.error = explainOmniError(error);
      row.mismatch = false;
    }
    render();
  };

  /** 每轮解析一个代币：旧一轮还没跑完的任务在新一轮开始后自动让位，不会把
   *  旧结果写进新批次。`allowAutoEnqueue` 只给「用户主动发起」的调用：
   *  打开页面时自动补搜上一批结果，不应悄悄把旧歌塞进队列。 */
  let resolveRun = 0;

  const resolveAll = async ({ allowAutoEnqueue = false } = {}) => {
    if (disposed) return;
    const run = ++resolveRun;
    resolvedThisSession = true;
    const pending = results.filter((row) => row.status === 'pending' || row.status === 'missing' || row.status === 'error');
    if (pending.length === 0) return;

    const availability = (() => {
      try {
        const providers = folium.omni.listProviders() ?? [];
        return providers.some((p) => p?.supports?.search);
      } catch {
        return false;
      }
    })();
    if (!availability) {
      for (const row of pending) { row.status = 'error'; row.error = tr('音源不可用', 'no search source'); }
      statusText = tr('没有可用的在线音源，推荐先保留为文字清单', 'No online source available; keeping the list as text');
      render();
      toast(say.noSource, 'error');
      return;
    }

    const cfg = readSettings();
    const wantEnqueue = allowAutoEnqueue && cfg.autoEnqueue;
    let newlyEnqueued = 0;
    // 队列空着时，第一首匹配到的歌直接开播，其余追加（播过的那首不再重复入队）。
    let playStarted = false;
    const enqueueRow = async (row) => {
      if (row.enqueued || !row.song) return;
      try {
        if (!playStarted) {
          const state = playback.getState();
          if (!state?.song) {
            const ok = await playback.playSong(row.song);
            if (ok === true) {
              playStarted = true;
              row.enqueued = true;
              render();
              return;
            }
          }
        }
        const ok = await playback.enqueue(row.song);
        row.enqueued = ok === true;
        if (ok === true) newlyEnqueued += 1;
        else row.error = tr('加入队列失败', 'enqueue failed');
      } catch (error) {
        row.error = explainOmniError(error);
      }
      render();
    };

    const pool = createPool(RESOLVE_POOL);
    await Promise.all(pending.map((row) => pool.run(async () => {
      if (disposed || run !== resolveRun) return;
      await searchOne(row);
      if (disposed || run !== resolveRun) return;
      // 自动入队只收「歌手也对得上」的匹配：版本不同(翻唱/合集署名差异)的
      // 行留给用户手动决定，避免封面版悄悄混进队列。
      if (wantEnqueue && row.status === 'found' && !row.mismatch) await enqueueRow(row);
    })));

    if (disposed || run !== resolveRun) return;
    if (wantEnqueue && newlyEnqueued > 0) toast(say.enqueued(newlyEnqueued), 'success');
  };

  // ---------------------------------------------------------------- 生成

  const sanitizeSongs = (songs, want) => {
    const rows = [];
    for (const song of songs) {
      if (!song || typeof song.title !== 'string' || !song.title.trim()) continue;
      const row = {
        title: song.title.trim().slice(0, 200),
        artist: typeof song.artist === 'string' ? song.artist.trim().slice(0, 200) : '',
        reason: typeof song.reason === 'string' ? song.reason.trim().slice(0, 200) : '',
        status: 'pending',
        song: null,
        error: '',
        enqueued: false,
        mismatch: false,
      };
      splitDashTitle(row);
      rows.push(row);
      if (rows.length >= want) break;
    }
    return rows;
  };

  /** 生成一批推荐。append=true 时新行追加在现有列表后面（电台补充用），
   *  并把新行数组返回给调用方，由它自己 await 解析完成后再处理；普通模式
   *  返回新行数量，解析在后台自动进行。 */
  const generate = async ({ announce = false, append = false } = {}) => {
    if (busy) return append ? [] : 0;
    const cfg = readSettings();
    if (!cfg.apiUrl) { toast(say.needUrl, 'error'); return append ? [] : 0; }
    if (!(await hasKey())) { toast(say.needKey, 'error'); return append ? [] : 0; }

    busy = true;
    statusText = say.generating;
    render();
    try {
      // 生成前先刷新一次「听歌档案」联动：listening-archive 随时在追加记录。
      await refreshArchive();
      const digest = buildDigest();
      const answer = await folium.rpc.call('recommend', {
        config: {
          apiUrl: cfg.apiUrl,
          model: cfg.model,
          temperature: cfg.temperature,
          want: cfg.recommendCount,
          userNote: cfg.userNote,
        },
        digest,
      });
      const songs = Array.isArray(answer?.songs) ? answer.songs : [];
      const want = Number.isFinite(cfg.recommendCount) ? Math.max(1, cfg.recommendCount) : 8;
      const rows = sanitizeSongs(songs, want);
      if (rows.length === 0) throw new Error(say.noSongs);
      if (append) {
        // 追加模式：电台在列表尾部续写，页面上能看到推荐不断累积。
        const known = new Set(results.map((row) => `${row.title}\u0000${row.artist}`));
        const fresh = rows.filter((row) => !known.has(`${row.title}\u0000${row.artist}`));
        results = [...results, ...fresh].slice(-RESULTS_CAP);
        statusText = say.generated(fresh.length);
        await saveResults();
        render();
        return fresh;
      }
      results = rows;
      resolvedThisSession = false;
      statusText = say.generated(rows.length);
      await saveResults();
      render();
      if (announce) toast(`AI 推荐了 ${rows.length} 首歌`, 'success');
      void resolveAll({ allowAutoEnqueue: true });
      return rows.length;
    } catch (error) {
      statusText = `${say.generateFailed}：${String(error?.message ?? error).slice(0, 160)}`;
      render();
      if (announce) toast(statusText, 'error');
      return append ? [] : 0;
    } finally {
      busy = false;
      void refreshKeyStatus();
      render();
    }
  };

  const clearHistory = async () => {
    history = { v: 1, songs: {}, recent: [] };
    try {
      await folium.storage.delete(HISTORY_KEY);
      toast(say.cleared, 'success');
    } catch (error) {
      log.warn?.('清除听歌历史失败', error);
    }
    render();
  };

  // ---------------------------------------------------------------- 推荐电台

  /* 「推荐电台」：持续播放 AI 推荐的守护会话。开启时立刻开播当前推荐列表，
   *  之后每次换歌和定时 tick 都检查队列「跑道」——当前歌之后剩余不足
   *  RADIO_RUNWAY_MIN 首时，在歌放完之前生成下一批推荐并追加进队列，无缝
   *  衔接。只用 playback.enqueue/playSong（playback.control 权限），不动
   *  replaceQueue，不接管用户的队列：用户自己的歌排在前面就先放完它们。 */

  const radioKeyOf = (song) => `${String(song?.source ?? '')}\u0000${String(song?.id ?? '')}`;

  /** 读完整条队列（分页），返回 {seen, length, currentIndex, kind}；舞台等
   *  非 queue 上下文返回 null。 */
  const readQueueKeys = () => {
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < 4; page += 1) {
      let head;
      try { head = playback.getQueue({ offset, limit: 500 }); } catch { return null; }
      if (!head || head.kind !== 'queue') return null;
      const items = Array.isArray(head.items) ? head.items : [];
      const length = Number(head.length) || 0;
      for (const item of items) {
        if (item?.song) seen.add(radioKeyOf(item.song));
      }
      offset += items.length;
      if (offset >= length || items.length === 0) {
        return { seen, length, currentIndex: Number.isFinite(head.currentIndex) ? head.currentIndex : -1 };
      }
    }
    return { seen, length: offset, currentIndex: -1 };
  };

  let radio = null; // null=关闭；{busy, cooldownUntil, sessionKeys}
  const radioListeners = new Set();
  const notifyRadio = () => {
    for (const listener of [...radioListeners]) {
      try { listener(); } catch { /* 面板已经被移除 */ }
    }
  };

  const stopRadio = (message) => {
    if (!radio) return;
    radio = null;
    notifyRadio();
    toast(message ?? tr('推荐电台已关闭，当前队列保持不变', 'Radio off; the queue is left as it is'), 'info');
  };

  /** 收集可见列表里「可进电台」的行：匹配成功、歌手也对得上。 */
  const playableRowsOf = () => results.filter((row) => row.status === 'found' && row.song && !row.mismatch);

  /** 开启电台：立刻开播推荐列表（第一首 playSong，其余 enqueue），之后由
   *  守护 tick 持续补充。 */
  const startRadio = async () => {
    if (radio) { stopRadio(); return; }
    if (busy) { toast(tr('正在生成推荐，稍候再开电台', 'Still generating; try again in a moment'), 'info'); return; }
    const queueInfo = readQueueKeys();
    if (!queueInfo) {
      toast(tr('当前播放上下文不支持推荐电台', 'Radio is not available in this playback context'), 'error');
      return;
    }
    radio = { busy: true, cooldownUntil: 0, sessionKeys: new Set() };
    notifyRadio();
    try {
      let playable = playableRowsOf();
      // 列表里还有没解析完的行：先补齐再挑。
      if (results.some((row) => row.status === 'pending')) {
        await resolveAll({ allowAutoEnqueue: false });
        if (!radio || disposed) return;
        playable = playableRowsOf();
      }
      // 列表里没有可播的：现场生成一批。
      if (playable.length === 0) {
        const freshRows = await generate({ announce: false, append: true });
        if (!radio || disposed) return;
        if (!Array.isArray(freshRows) || freshRows.length === 0) {
          stopRadio(tr('没拿到推荐：请检查 AI 接口设置后再开电台', 'No recommendations available; check the AI settings'));
          return;
        }
        await resolveAll({ allowAutoEnqueue: false });
        if (!radio || disposed) return;
        playable = playableRowsOf();
      }
      if (playable.length === 0) {
        stopRadio(tr('音源里没匹配到可播放的推荐，电台没有开启', 'No playable matches; radio not started'));
        return;
      }
      // 开播第一首（跳过队列里已有的），其余追加。
      const first = playable.find((row) => !queueInfo.seen.has(radioKeyOf(row.song))) ?? playable[0];
      await playback.playSong(first.song);
      radio.sessionKeys.add(radioKeyOf(first.song));
      let added = 0;
      for (const row of playable) {
        if (row === first) continue;
        const key = radioKeyOf(row.song);
        if (queueInfo.seen.has(key) || radio.sessionKeys.has(key)) continue;
        try {
          if (await playback.enqueue(row.song) === true) {
            radio.sessionKeys.add(key);
            queueInfo.seen.add(key);
            added += 1;
          }
        } catch { /* 单首失败不影响整体 */ }
      }
      toast(tr(
        `推荐电台已开启：正在播放推荐列表${added > 0 ? `（${added} 首已排入队列）` : ''}，队列快放完时会自动补充新推荐`,
        `Radio on: playing the list${added > 0 ? `, ${added} enqueued` : ''}; more recommendations are added before the queue runs out`,
      ), 'success');
    } catch (error) {
      radio = null;
      log.warn?.('推荐电台开启失败', error);
      toast(`${tr('电台没能开启', 'Radio failed to start')}：${String(error?.message ?? error).slice(0, 120)}`, 'error');
    } finally {
      if (radio) radio.busy = false;
      notifyRadio();
      render();
    }
  };

  /** 守护补充：跑道不足就生成下一批、解析、追加进队列。 */
  const radioTopUp = async () => {
    if (!radio || disposed || radio.busy) return;
    if (Date.now() < radio.cooldownUntil) return;
    radio.busy = true;
    notifyRadio();
    try {
      const queueInfo = readQueueKeys();
      if (!queueInfo) { stopRadio(); return; }
      const runway = queueInfo.length - 1 - queueInfo.currentIndex;
      if (runway >= RADIO_RUNWAY_MIN) return;

      const freshRows = await generate({ announce: false, append: true });
      if (!radio || disposed) return;
      if (!Array.isArray(freshRows) || freshRows.length === 0) {
        radio.cooldownUntil = Date.now() + RADIO_COOLDOWN_MS;
        return;
      }
      await resolveAll({ allowAutoEnqueue: false });
      if (!radio || disposed) return;

      let added = 0;
      let firstAdded = null;
      for (const row of freshRows) {
        if (row.status !== 'found' || !row.song || row.mismatch) continue;
        const key = radioKeyOf(row.song);
        if (queueInfo.seen.has(key) || radio.sessionKeys.has(key)) continue;
        try {
          if (await playback.enqueue(row.song) === true) {
            radio.sessionKeys.add(key);
            queueInfo.seen.add(key);
            added += 1;
            if (!firstAdded) firstAdded = row.song;
          }
        } catch { /* 单首失败不影响整体 */ }
      }
      if (added === 0) {
        radio.cooldownUntil = Date.now() + RADIO_COOLDOWN_MS;
        return;
      }
      // 队列放空、播放已经停了：把新补充的第一首直接开播。
      const state = playback.getState();
      if (!state?.song && firstAdded) {
        try { await playback.playSong(firstAdded); } catch { /* 放不了就等用户手动 */ }
      }
      toast(tr(`推荐电台：已补充 ${added} 首新推荐进队列`, `Radio: ${added} new recommendations queued`), 'info');
    } catch (error) {
      radio.cooldownUntil = Date.now() + RADIO_COOLDOWN_MS;
      log.warn?.('推荐电台补充失败', error);
    } finally {
      if (radio) radio.busy = false;
      notifyRadio();
    }
  };

  const radioTick = () => {
    if (!radio || disposed) return;
    if (radio.busy || Date.now() < radio.cooldownUntil) return;
    // 跑道检查放在 topUp 里做；这里只是低频唤起。
    void radioTopUp();
  };

  const toggleRadio = () => {
    if (radio) stopRadio();
    else void startRadio();
  };

  // ---------------------------------------------------------------- 首页标签页

  const uiListeners = new Set();
  const render = () => {
    for (const listener of [...uiListeners]) {
      try { listener(); } catch { /* 面板已经被移除 */ }
    }
  };

  const icon = async (name, size = 14) => {
    try {
      return await folium.ui.icon(name, { size });
    } catch {
      return null;
    }
  };

  const css = {
    root: 'display:flex;flex-direction:column;gap:18px;padding:24px 28px;max-width:880px;margin:0 auto;font-family:var(--folium-font,inherit);color:var(--folium-primary,#fafafa);font-size:13px;line-height:1.6;',
    heading: 'font-size:17px;font-weight:700;letter-spacing:0.2px;',
    dim: 'opacity:0.62;',
    dimmer: 'opacity:0.45;font-size:12px;',
    card: 'border:1px solid var(--folium-secondary,#a1a1aa);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:rgba(127,127,127,0.06);',
    primaryBtn: 'all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:999px;border:1px solid var(--folium-accent,#fafafa);color:var(--folium-primary,#fafafa);font-size:13px;font-weight:600;transition:opacity .15s ease;',
    ghostBtn: 'all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;border:1px solid var(--folium-secondary,#a1a1aa);opacity:0.8;font-size:12px;transition:opacity .15s ease;',
    rowBtn: 'all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--folium-secondary,#a1a1aa);opacity:0.75;transition:opacity .15s ease;',
    chip: 'display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;border:1px solid var(--folium-secondary,#a1a1aa);font-size:12px;opacity:0.8;',
    sectionTitle: 'font-size:13px;font-weight:600;opacity:0.75;',
    statusOk: 'color:#4ade80;',
    statusWarn: 'color:#fbbf24;',
    statusBad: 'color:#f87171;',
  };

  const hover = (element) => {
    element.addEventListener('mouseenter', () => { element.style.opacity = '1'; });
    element.addEventListener('mouseleave', () => { element.style.opacity = '0.8'; });
    return element;
  };

  const mountHomeTab = (container, ctx) => {
    if (ctx?.locale) currentLang = String(ctx.locale);
    const root = document.createElement('div');
    root.style.cssText = css.root;
    container.appendChild(root);

    /* keyframes 挂在容器的兄弟节点上：paint() 会整棵替换 root 的子节点，
     * 挂在 root 里第一次重绘就被清掉了。 */
    const style = document.createElement('style');
    style.textContent = '@keyframes folium-aimr-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    container.appendChild(style);

    let iconCache = {};
    void (async () => {
      for (const name of ['sparkles', 'play', 'list-plus', 'refresh-cw', 'loader-circle']) {
        iconCache[name] = await icon(name, 14);
      }
      paint();
    })();

    const paint = () => {
      const cfg = readSettings();
      const hist = history ?? { songs: {}, recent: [] };
      const songs = Object.values(hist.songs);
      const totalPlays = songs.reduce((sum, s) => sum + s.p, 0);

      root.replaceChildren();

      // ── 标题 + 档案规模
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
      const title = document.createElement('div');
      title.style.cssText = css.heading;
      title.textContent = tr('AI 推荐音乐', 'AI music recommendations');
      header.appendChild(title);
      const stats = document.createElement('div');
      stats.style.cssText = css.dim;
      stats.textContent = songs.length > 0
        ? tr(`已记录 ${songs.length} 首歌 · 累计播放 ${totalPlays} 次`, `${songs.length} tracks · ${totalPlays} plays`)
        : tr('还没有听歌记录：多听几首，AI 就能认识你的口味', 'No history yet — play a few songs first');
      header.appendChild(stats);
      // 「听歌档案」联动状态（只在本模组设置开启联动时展示）。
      if (archiveStatusKnown && archiveLinked()) {
        const archiveLine = document.createElement('div');
        archiveLine.style.cssText = css.dimmer;
        const linked = archiveProfile?.status === 'linked';
        archiveLine.textContent = linked
          ? tr(
            `已联动「听歌档案」：${archiveProfile.sessions} 次播放、${archiveProfile.songs} 首歌的长期记录已并入口味档案`,
            `Linked with Listening Archive: ${archiveProfile.sessions} sessions across ${archiveProfile.songs} tracks feed the profile`,
          )
          : archiveProfile?.status === 'no-records'
            ? tr('已联动「听歌档案」：它还没有记录，先用本模组自己记录的', 'Listening Archive linked but has no records yet')
            : tr('未检测到「听歌档案」：仅使用本模组自己记录的听歌数据', 'Listening Archive not detected; using this mod’s own records');
        header.appendChild(archiveLine);
      }
      root.appendChild(header);

      // ── 生成卡片
      const card = document.createElement('div');
      card.style.cssText = css.card;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
      const generateBtn = document.createElement('button');
      generateBtn.type = 'button';
      generateBtn.style.cssText = css.primaryBtn;
      generateBtn.disabled = busy;
      generateBtn.style.opacity = busy ? '0.5' : '1';
      generateBtn.style.cursor = busy ? 'progress' : 'pointer';
      const btnIcon = iconCache.sparkles;
      if (btnIcon) {
        const holder = document.createElement('span');
        holder.style.cssText = 'display:inline-flex;';
        holder.appendChild(btnIcon.cloneNode ? btnIcon.cloneNode(true) : btnIcon);
        generateBtn.appendChild(holder);
      }
      generateBtn.appendChild(document.createTextNode(busy ? tr('推荐中…', 'Working…') : tr('生成推荐', 'Generate recommendations')));
      generateBtn.addEventListener('click', () => { void generate({ announce: true }); });
      btnRow.appendChild(generateBtn);

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.style.cssText = css.ghostBtn;
      refreshBtn.textContent = tr('重新搜索匹配', 'Re-search matches');
      hover(refreshBtn);
      refreshBtn.addEventListener('click', () => {
        for (const row of results) row.status = 'pending';
        void resolveAll({ allowAutoEnqueue: true });
      });
      btnRow.appendChild(refreshBtn);

      const radioBtn = document.createElement('button');
      radioBtn.type = 'button';
      radioBtn.style.cssText = radio
        ? `${css.ghostBtn} border-color:var(--folium-accent,#fafafa);opacity:1;`
        : css.ghostBtn;
      radioBtn.textContent = radio
        ? (radio.busy
          ? tr('电台：正在补充推荐…', 'Radio: refilling…')
          : tr('电台运行中 · 点击关闭', 'Radio on · click to stop'))
        : tr('播放推荐列表（连播）', 'Play the list (radio)');
      hover(radioBtn);
      radioBtn.addEventListener('click', () => { void startRadio(); });
      btnRow.appendChild(radioBtn);
      card.appendChild(btnRow);

      if (statusText) {
        const status = document.createElement('div');
        status.style.cssText = css.dim;
        status.textContent = statusText;
        card.appendChild(status);
      }

      if (radio) {
        const radioLine = document.createElement('div');
        radioLine.style.cssText = css.dim;
        radioLine.textContent = tr(
          '推荐电台运行中：当前歌之后队列不足 2 首时，自动生成并追加下一批推荐，无缝衔接。',
          'Radio running: when fewer than 2 songs remain ahead, the next batch is generated and appended seamlessly.',
        );
        card.appendChild(radioLine);
      }

      if (!cfg.apiUrl || !cfg.model) {
        const hint = document.createElement('div');
        hint.style.cssText = css.statusWarn;
        hint.textContent = tr(
          '接口地址和模型填在「模组面板 → AI 推荐音乐」里；API 密钥在那里加密保存。',
          'Set the endpoint and model in Mods panel → AI music recommendations; the key is stored there encrypted.',
        );
        card.appendChild(hint);
      } else if (keyKnown === false) {
        const hint = document.createElement('div');
        hint.style.cssText = css.statusWarn;
        hint.textContent = tr('还没填 API 密钥：请在「模组面板 → AI 推荐音乐」的「API 密钥」里填写。', 'No API key yet — add it in the mod settings.');
        card.appendChild(hint);
      }
      root.appendChild(card);

      // ── 推荐列表
      if (results.length > 0) {
        const listTitle = document.createElement('div');
        listTitle.style.cssText = css.sectionTitle;
        listTitle.textContent = tr('本轮推荐', 'This batch');
        root.appendChild(listTitle);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
        results.forEach((row, index) => {
          const line = document.createElement('div');
          line.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;border:1px solid var(--folium-secondary,#a1a1aa);background:rgba(127,127,127,0.04);';

          const num = document.createElement('div');
          num.style.cssText = 'opacity:0.45;font-variant-numeric:tabular-nums;min-width:20px;text-align:right;';
          num.textContent = String(index + 1);
          line.appendChild(num);

          const info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
          const nameLine = document.createElement('div');
          nameLine.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          const matched = row.status === 'found' && row.song;
          if (matched) {
            // 显示实际会播放的那首歌：匹配结果才是真相，不能拿 AI 的原话冒充。
            nameLine.textContent = row.song.artist ? `${row.song.title} — ${row.song.artist}` : (row.song.title || row.title);
          } else {
            nameLine.textContent = row.artist ? `${row.title} — ${row.artist}` : row.title;
          }
          info.appendChild(nameLine);
          const reasonLine = document.createElement('div');
          reasonLine.style.cssText = css.dimmer;
          const statusNote = row.status === 'searching'
            ? tr(' 搜索中…', ' searching…')
            : row.status === 'missing'
              ? tr(' · 没在音源找到', ' · not found')
              : row.status === 'error'
                ? ` · ${row.error}`
                : '';
          reasonLine.textContent = `${row.reason || (row.artist ? '' : tr('（AI 没给歌手名）', '(no artist)'))}${statusNote}`;
          info.appendChild(reasonLine);
          if (matched && row.mismatch) {
            const warn = document.createElement('div');
            warn.style.cssText = css.statusWarn;
            warn.textContent = tr(
              `⚠ 音源里没找到「${row.artist}」的版本，已匹配其他歌手；自动入队跳过了这首`,
              `⚠ ${row.artist}'s version not found; matched another artist, skipped by auto-enqueue`,
            );
            info.appendChild(warn);
          } else if (matched && (row.song.title !== row.title || (row.song.artist ?? '') !== row.artist)) {
            const note = document.createElement('div');
            note.style.cssText = css.dimmer;
            note.textContent = tr(
              `AI 原推荐：${row.artist ? `${row.title} — ${row.artist}` : row.title}`,
              `AI suggested: ${row.artist ? `${row.title} — ${row.artist}` : row.title}`,
            );
            info.appendChild(note);
          }
          line.appendChild(info);

          const actions = document.createElement('div');
          actions.style.cssText = 'display:flex;gap:6px;align-items:center;';
          if (row.status === 'found' && row.song) {
            const play = document.createElement('button');
            play.type = 'button';
            play.title = tr('立即播放', 'Play now');
            play.style.cssText = css.rowBtn;
            const playIcon = iconCache.play;
            if (playIcon) play.appendChild(playIcon.cloneNode(true));
            else play.textContent = '▶';
            hover(play);
            play.addEventListener('click', () => {
              void playback.playSong(row.song).then((ok) => {
                if (!ok) toast(tr('没能开始播放', 'could not play'), 'error');
              }).catch((error) => toast(explainOmniError(error), 'error'));
            });
            actions.appendChild(play);

            const plus = document.createElement('button');
            plus.type = 'button';
            plus.title = tr('加入队列', 'Enqueue');
            plus.style.cssText = css.rowBtn;
            const plusIcon = iconCache['list-plus'];
            if (plusIcon) plus.appendChild(plusIcon.cloneNode(true));
            else plus.textContent = '+';
            hover(plus);
            plus.addEventListener('click', () => {
              void Promise.resolve(playback.enqueue(row.song)).then((ok) => {
                if (!ok) toast(tr('没能加入队列', 'could not enqueue'), 'error');
                else toast(tr('已加入队列', 'enqueued'), 'success');
              }).catch((error) => toast(explainOmniError(error), 'error'));
            });
            actions.appendChild(plus);
          } else if (row.status === 'searching') {
            const spin = iconCache['loader-circle'];
            if (spin) {
              spin.style.animation = 'folium-aimr-spin 1s linear infinite';
              actions.appendChild(spin.cloneNode(true));
            } else {
              const wait = document.createElement('div');
              wait.style.cssText = css.dim;
              wait.textContent = '…';
              actions.appendChild(wait);
            }
          } else if (row.status === 'error' || row.status === 'missing') {
            const warn = document.createElement('div');
            warn.style.cssText = row.status === 'error' ? css.statusBad : css.dim;
            warn.textContent = row.status === 'error' ? (row.error || tr('搜索失败', 'failed')) : tr('未找到', 'not found');
            actions.appendChild(warn);
          }
          line.appendChild(actions);
          list.appendChild(line);
        });
        root.appendChild(list);
      }

      // ── 听歌档案
      const artistCounts = new Map();
      for (const song of songs) {
        for (const name of splitArtists(song.a)) artistCounts.set(name, (artistCounts.get(name) ?? 0) + song.p);
      }
      const topArtists = [...artistCounts.entries()].filter(([, p]) => p > 0).sort((x, y) => y[1] - x[1]).slice(0, 8);
      if (topArtists.length > 0) {
        const profileCard = document.createElement('div');
        profileCard.style.cssText = css.card;
        const profileTitle = document.createElement('div');
        profileTitle.style.cssText = css.sectionTitle;
        profileTitle.textContent = tr('AI 眼中的你（常听歌手）', 'Your top artists');
        profileCard.appendChild(profileTitle);
        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
        for (const [name, plays] of topArtists) {
          const chip = document.createElement('span');
          chip.style.cssText = css.chip;
          chip.textContent = `${name} ×${plays}`;
          chips.appendChild(chip);
        }
        profileCard.appendChild(chips);
        root.appendChild(profileCard);
      }

      const recent = (hist.recent ?? []).slice(0, 10);
      if (recent.length > 0) {
        const recentCard = document.createElement('div');
        recentCard.style.cssText = css.card;
        const recentTitle = document.createElement('div');
        recentTitle.style.cssText = css.sectionTitle;
        recentTitle.textContent = tr('最近播放', 'Recently played');
        recentCard.appendChild(recentTitle);
        const list2 = document.createElement('div');
        list2.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        for (const entry of recent) {
          const line = document.createElement('div');
          line.style.cssText = `${css.dim} white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
          line.textContent = entry.a ? `${entry.a}《${entry.t}》` : `《${entry.t}》`;
          list2.appendChild(line);
        }
        recentCard.appendChild(list2);
        root.appendChild(recentCard);
      }

      // ── 清除历史
      if (songs.length > 0) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.style.cssText = `${css.ghostBtn} color:var(--folium-primary,#fafafa);`;
        const armed = Date.now() - clearArmedAt < CLEAR_ARM_MS;
        clearBtn.textContent = armed ? say.clearConfirm : tr('清除听歌记录', 'Clear history');
        if (armed) clearBtn.style.color = '#f87171';
        hover(clearBtn);
        clearBtn.addEventListener('click', () => {
          if (Date.now() - clearArmedAt < CLEAR_ARM_MS) {
            clearArmedAt = 0;
            void clearHistory();
          } else {
            clearArmedAt = Date.now();
            paint();
            setTimeout(() => { if (Date.now() - clearArmedAt >= CLEAR_ARM_MS) paint(); }, CLEAR_ARM_MS + 200);
          }
        });
        root.appendChild(clearBtn);
      }

      const footer = document.createElement('div');
      footer.style.cssText = css.dimmer;
      footer.textContent = tr(
        '听歌满 30 秒记一次播放；快速切歌会记为「跳过」，AI 会避开你常跳过的歌手。',
        'A play counts after 30 s; quick skips are remembered so the AI avoids them.',
      );
      root.appendChild(footer);
    };

    paint();
    uiListeners.add(paint);
    try { ctx?.subscribe?.(() => paint()); } catch { /* 老宿主没有 subscribe */ }

    // 打开页面时：刷新「听歌档案」联动状态；有上次的推荐还没在本会话搜索过，
    // 就补搜一轮。注意这里不给 allowAutoEnqueue：只是补齐匹配结果，不悄悄把
    // 旧歌塞进队列。
    void refreshArchive().then(() => paint());
    if (!resolvedThisSession && results.some((row) => row.status === 'pending')) {
      void resolveAll();
    }

    return () => {
      uiListeners.delete(paint);
      root.remove();
      style.remove();
    };
  };

  folium.registries.homeTabs.register({
    id: 'recommend',
    label: T('AI 推荐', 'AI picks'),
    mount: mountHomeTab,
  });

  // ---------------------------------------------------------------- 命令

  const openPanel = () => {
    try { folium.ui.openHomeTab('recommend'); } catch (error) { log.warn?.('打开推荐页失败', error); }
  };

  folium.registries.commands.register({
    id: 'generate',
    label: T('AI 推荐音乐：生成推荐', 'AI music: generate recommendations'),
    description: T(
      '根据听歌档案让 AI 推荐一批歌，并自动在音源里搜索匹配',
      'Ask the AI for a batch of songs based on your listening profile',
    ),
    keywords: ['ai', '推荐', 'recommend', 'music', '音乐'],
    run: () => {
      openPanel();
      void generate({ announce: true });
      return tr('正在生成 AI 推荐…', 'Generating AI recommendations…');
    },
  });

  folium.registries.commands.register({
    id: 'open',
    label: T('AI 推荐音乐：打开推荐页', 'AI music: open the panel'),
    description: T('打开首页的「AI 推荐」标签页', 'Open the AI recommendations home tab'),
    keywords: ['ai', '推荐', 'recommend'],
    run: () => {
      openPanel();
      return null;
    },
  });

  folium.registries.commands.register({
    id: 'radio',
    label: T('AI 推荐音乐：推荐电台', 'AI music: recommendation radio'),
    description: T(
      '连播 AI 推荐列表：队列快放完时自动生成并追加下一批推荐，无限续播',
      'Play the AI recommendation list end-to-end, topping the queue up before it runs out',
    ),
    keywords: ['ai', '电台', 'radio', '连播', '推荐'],
    run: () => {
      void startRadio();
      return radio ? tr('推荐电台已开启', 'Radio on') : tr('推荐电台已关闭', 'Radio off');
    },
  });

  folium.registries.commands.register({
    id: 'clear-history',
    label: T('AI 推荐音乐：清除听歌记录', 'AI music: clear listening history'),
    description: T('删掉这个模组记录的全部听歌数据', 'Delete all listening data recorded by this mod'),
    keywords: ['ai', '清除', 'clear', 'history'],
    run: () => {
      void clearHistory();
      return tr('已清除听歌记录', 'Listening history cleared');
    },
  });

  // ---------------------------------------------------------------- 接线

  /* 进度条右侧的电台开关：和「心动模式」的开关同款位置，一键连播/停止。 */
  folium.registries.progressButtons.register({
    id: 'radio-toggle',
    slot: 'progress.trailing',
    order: 450,
    mount(container, ctx) {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.cssText = [
        'all:unset',
        'cursor:pointer',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'width:24px',
        'height:24px',
        'border-radius:7px',
        'opacity:0.72',
        'transition:opacity .15s ease,transform .15s ease,color .15s ease',
        'position:relative',
      ].join(';');
      container.appendChild(button);

      let icon = null;
      const painter = () => {
        const active = Boolean(radio);
        const colors = ctx.getColors?.() ?? {};
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.setAttribute('aria-busy', radio?.busy ? 'true' : 'false');
        button.title = radio
          ? (radio.busy
            ? tr('推荐电台：正在补充推荐（点击关闭）', 'Radio: refilling (click to stop)')
            : tr('推荐电台运行中（点击关闭）', 'Radio running (click to stop)'))
          : tr('推荐电台：连播 AI 推荐列表', 'Radio: play the AI recommendation list');
        button.style.color = active ? (colors.fill || '#8b5cf6') : (colors.text || 'currentColor');
        button.style.opacity = radio?.busy ? '0.45' : '0.72';
        button.style.transform = radio?.busy ? 'scale(0.9)' : 'scale(1)';
        if (icon) {
          icon.style.fill = active ? 'currentColor' : 'none';
          icon.style.stroke = 'currentColor';
        }
      };

      void icon('radio', 15).then((element) => {
        if (!element) return;
        icon = element;
        button.replaceChildren(element);
        painter();
      }).catch(() => { /* 图标取不到不影响功能 */ });

      button.addEventListener('mouseenter', () => { if (!radio) button.style.opacity = '1'; });
      button.addEventListener('mouseleave', () => { if (!radio) button.style.opacity = '0.72'; });
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleRadio();
      });
      radioListeners.add(painter);
      painter();
      try { ctx?.onChange?.(painter); } catch { /* 老宿主没有 onChange */ }
      return () => {
        radioListeners.delete(painter);
        button.remove();
      };
    },
  });

  const unsubscribers = [];
  try { unsubscribers.push(folium.events.on('playback.songChanged', onSongChanged)); } catch (error) { log.warn?.('songChanged 监听失败', error); }
  try {
    unsubscribers.push(folium.every(1000, () => {
      tickPlayback();
      radioTick();
    }));
  } catch (error) { log.warn?.('定时器创建失败', error); }
  try { unsubscribers.push(settingsSection.settings.onChange(() => { void refreshKeyStatus(); render(); })); } catch { /* 老宿主没有 onChange */ }

  // 启动：读历史与上次结果；模组启用时若已有歌在放，把当前歌标成「已计」，
  // 避免每次开机都给恢复出来的那首歌多记一次。
  void (async () => {
    await loadHistory();
    await loadResults();
    await refreshArchive();
    try {
      const song = playback.getState()?.song;
      if (song?.ref) current = { key: keyOf(songSnapshot(song)), dto: songSnapshot(song), since: Date.now(), counted: true };
    } catch { /* 还没有播放状态 */ }
    void refreshKeyStatus();
    render();
    log.info('AI 推荐音乐已就绪');
  })();

  return () => {
    disposed = true;
    for (const off of unsubscribers) {
      try { off(); } catch { /* 已经没了 */ }
    }
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; void saveHistoryNow(); }
    uiListeners.clear();
  };
}
