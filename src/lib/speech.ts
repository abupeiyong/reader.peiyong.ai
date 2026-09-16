// 朗读(TTS):优先云端 /api/tts(后端接 ElevenLabs eleven_v3),
// 不可用时回退浏览器 speechSynthesis。段落逐句播放以保持句级高亮同步。

export type Accent = "US" | "GB";

// ---------- 云端音频(ElevenLabs)----------

const audioCache = new Map<string, string>(); // `${accent}:${text}` -> objectURL
const inflight = new Map<string, Promise<string | null>>(); // 同一句同时被预取和播放时只发一次请求
const MAX_CACHED = 300;                                     // 超出后按插入顺序淘汰,释放 objectURL
let cloudTtsAvailable = true;

function rememberAudio(key: string, url: string) {
  audioCache.set(key, url);
  while (audioCache.size > MAX_CACHED) {
    const oldest = audioCache.keys().next();
    if (oldest.done) break;
    const stale = audioCache.get(oldest.value);
    if (stale) URL.revokeObjectURL(stale);
    audioCache.delete(oldest.value);
  }
}

async function fetchTtsUrl(text: string, accent: Accent): Promise<string | null> {
  if (!cloudTtsAvailable || !text.trim()) return null;
  const key = `${accent}:${text}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending; // 预取还没回来就播到了这句:复用同一个请求,别再打一次 ElevenLabs

  const task = (async () => {
    try {
      const res = await fetch(`/api/tts?accent=${accent}&text=${encodeURIComponent(text.slice(0, 800))}`);
      if (!res.ok) {
        if (res.status === 503) cloudTtsAvailable = false; // 服务端无任何 TTS provider
        return null;
      }
      const blob = await res.blob();
      if (blob.size < 100) return null;
      const url = URL.createObjectURL(blob);
      rememberAudio(key, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

function clampRate(r: number): number {
  return Math.max(0.5, Math.min(2, r));
}

// ---------- 浏览器合成(回退)----------

let cachedVoices: SpeechSynthesisVoice[] = [];

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const vs = speechSynthesis.getVoices();
    if (vs.length) {
      cachedVoices = vs;
      resolve(vs);
      return;
    }
    speechSynthesis.onvoiceschanged = () => {
      cachedVoices = speechSynthesis.getVoices();
      resolve(cachedVoices);
    };
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
}

export async function pickVoice(accent: Accent): Promise<SpeechSynthesisVoice | null> {
  const voices = cachedVoices.length ? cachedVoices : await loadVoices();
  const lang = accent === "US" ? "en-US" : "en-GB";
  const prefer =
    accent === "US"
      ? ["Google US English", "Samantha", "Alex", "Microsoft Aria"]
      : ["Google UK English Female", "Google UK English Male", "Daniel", "Kate", "Microsoft Sonia"];
  const candidates = voices.filter((v) => v.lang.replace("_", "-").startsWith(lang));
  for (const name of prefer) {
    const v = candidates.find((c) => c.name.includes(name));
    if (v) return v;
  }
  return candidates[0] ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
}

export interface TtsController {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  readonly paused: boolean;
}

export interface TtsOptions {
  accent: Accent;
  rate: number;
  startIndex?: number;
  onSentence?: (index: number) => void;
  onEnd?: () => void;
}

/** 逐句朗读,支持从某句开始、暂停/继续、句级回调。优先云端音频,回退浏览器。 */
export function speakSentences(sentences: string[], opts: TtsOptions): TtsController {
  let stopped = false;
  let paused = false;
  let idx = opts.startIndex ?? 0;
  let audio: HTMLAudioElement | null = null;
  let mode: "pending" | "cloud" | "browser" = "pending";
  let current: "cloud" | "browser" = "cloud"; // 当前这句实际用的通道(暂停/继续要分开处理)

  // 浏览器合成单句(云端整体不可用、或云端这一句取不到音频时用)
  const speakOneBrowser = (cur: number, done: () => void) => {
    void pickVoice(opts.accent).then((voice) => {
      if (stopped) return;
      const u = new SpeechSynthesisUtterance(sentences[cur]);
      if (voice) u.voice = voice;
      u.lang = opts.accent === "US" ? "en-US" : "en-GB";
      u.rate = opts.rate;
      current = "browser";
      opts.onSentence?.(cur);
      u.onend = () => {
        if (!stopped) done();
      };
      u.onerror = () => {
        if (!stopped) done();
      };
      speechSynthesis.speak(u);
    });
  };

  const playCloud = async () => {
    if (stopped) return;
    if (idx >= sentences.length) {
      opts.onEnd?.();
      return;
    }
    const cur = idx;
    const url = await fetchTtsUrl(sentences[cur], opts.accent);
    if (stopped) return;
    if (!url) {
      if (mode === "pending") {
        mode = "browser";
        speakBrowser();
        return;
      }
      // 云端偶发取不到这一句(限流/网络):用浏览器合成读完它,下一句继续走云端。
      // 直接跳过的话这句既不出声也不高亮。
      speakOneBrowser(cur, () => {
        idx = cur + 1;
        void playCloud();
      });
      return;
    }
    mode = "cloud";
    current = "cloud";
    opts.onSentence?.(cur);
    if (cur + 1 < sentences.length) void fetchTtsUrl(sentences[cur + 1], opts.accent); // 预取
    audio = new Audio(url);
    audio.playbackRate = clampRate(opts.rate);
    audio.onended = () => {
      if (stopped) return;
      idx = cur + 1;
      void playCloud();
    };
    audio.onerror = () => {
      if (stopped) return;
      idx = cur + 1;
      void playCloud();
    };
    try {
      await audio.play();
    } catch {
      /* autoplay 限制,忽略 */
    }
  };

  // 浏览器逐句合成(云端整体不可用时的回退)
  const speakBrowser = () => {
    if (stopped || idx >= sentences.length) {
      if (!stopped) opts.onEnd?.();
      return;
    }
    const cur = idx;
    speakOneBrowser(cur, () => {
      idx = cur + 1;
      speakBrowser();
    });
  };

  speechSynthesis.cancel();
  void playCloud();

  return {
    stop() {
      stopped = true;
      audio?.pause();
      audio = null;
      speechSynthesis.cancel();
    },
    pause() {
      paused = true;
      if (current === "cloud") audio?.pause();
      else speechSynthesis.pause();
    },
    resume() {
      paused = false;
      if (current === "cloud") void audio?.play();
      else speechSynthesis.resume();
    },
    get paused() {
      return paused;
    },
  };
}

/** 预取单词发音(与查词并行发起):音频进内存缓存,点发音时零等待 */
export function prefetchWordAudio(word: string, accent: Accent = "US"): void {
  void fetchTtsUrl(word, accent);
}

/** 朗读单词/短语:优先云端(ElevenLabs),回退浏览器 */
export async function speakWord(word: string, accent: Accent = "US"): Promise<void> {
  const url = await fetchTtsUrl(word, accent);
  if (url) {
    try {
      await new Audio(url).play();
      return;
    } catch {
      /* 回退浏览器 */
    }
  }
  const voice = await pickVoice(accent);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  if (voice) u.voice = voice;
  u.lang = accent === "US" ? "en-US" : "en-GB";
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
