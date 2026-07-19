// 朗读(TTS):优先云端 /api/tts(后端接 ElevenLabs eleven_v3),
// 不可用时回退浏览器 speechSynthesis。段落逐句播放以保持句级高亮同步。

export type Accent = "US" | "GB";

// ---------- 云端音频(ElevenLabs)----------

const audioCache = new Map<string, string>(); // `${accent}:${text}` -> objectURL
let cloudTtsAvailable = true;

async function fetchTtsUrl(text: string, accent: Accent): Promise<string | null> {
  if (!cloudTtsAvailable || !text.trim()) return null;
  const key = `${accent}:${text}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(`/api/tts?accent=${accent}&text=${encodeURIComponent(text.slice(0, 800))}`);
    if (!res.ok) {
      if (res.status === 503) cloudTtsAvailable = false; // 服务端无任何 TTS provider
      return null;
    }
    const blob = await res.blob();
    if (blob.size < 100) return null;
    const url = URL.createObjectURL(blob);
    audioCache.set(key, url);
    return url;
  } catch {
    return null;
  }
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
      idx = cur + 1;
      void playCloud();
      return;
    }
    mode = "cloud";
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

  // 浏览器逐句合成(回退)
  const speakBrowser = () => {
    if (stopped || idx >= sentences.length) {
      if (!stopped) opts.onEnd?.();
      return;
    }
    void pickVoice(opts.accent).then((voice) => {
      if (stopped) return;
      const cur = idx;
      const u = new SpeechSynthesisUtterance(sentences[cur]);
      if (voice) u.voice = voice;
      u.lang = opts.accent === "US" ? "en-US" : "en-GB";
      u.rate = opts.rate;
      opts.onSentence?.(cur);
      u.onend = () => {
        if (stopped) return;
        idx = cur + 1;
        speakBrowser();
      };
      u.onerror = () => {
        if (stopped) return;
        idx = cur + 1;
        speakBrowser();
      };
      speechSynthesis.speak(u);
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
      if (mode === "cloud") audio?.pause();
      else speechSynthesis.pause();
    },
    resume() {
      paused = false;
      if (mode === "cloud") void audio?.play();
      else speechSynthesis.resume();
    },
    get paused() {
      return paused;
    },
  };
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
