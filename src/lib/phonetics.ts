// 音标表:英音(RP)/ 美音(GA)各一套元音与双元音,辅音两套共用。
//
// 发音怎么来:直接把 IPA 丢给 TTS 会被逐字念成「slash i colon slash」,所以每个音素
// 另存一个 cue —— 英语里能把这个音读出来的拼法(/p/ → "puh",/iː/ → "ee")——
// 再跟上代表词,点音标时念「cue, keyword」。有些音在英语里没法单独成音节
// (/ŋ/、/æ/、/ʊ/、/θ/ 这类 cue 容易被 TTS 读成字母),就省掉 cue 只念代表词。

export interface Phoneme {
  /** IPA 符号,不带两侧斜杠 */
  ipa: string;
  /** 念给 TTS 的发音提示;省略时只念 keyword */
  cue?: string;
  /** 代表词(lexical set 的关键词) */
  keyword: string;
  /** 例词,点一下逐词朗读 */
  examples: string[];
}

/** 元音在元音图里的舌位:x 0=前 100=后,y 0=闭(高)100=开(低) */
export interface VowelPhoneme extends Phoneme {
  x: number;
  y: number;
}

export interface PhonemeGroup {
  name: string;
  hint: string;
  items: Phoneme[];
}

export interface AccentChart {
  /** TTS 口音,与 lib/speech.ts 的 Accent 对齐 */
  accent: "GB" | "US";
  label: string;
  /** 单元音,画在元音图上 */
  vowels: VowelPhoneme[];
  /** 双元音,元音图上是一段滑动而非一个点,所以单列一组 */
  diphthongs: Phoneme[];
}

/** 点音标时念的文本 */
export function phonemeSpeech(p: Phoneme): string {
  return p.cue ? `${p.cue}, ${p.keyword}` : p.keyword;
}

const GB: AccentChart = {
  accent: "GB",
  label: "British",
  vowels: [
    { ipa: "iː", cue: "ee", keyword: "sheep", examples: ["see", "sheep", "meat", "key"], x: 4, y: 4 },
    { ipa: "ɪ", cue: "ih", keyword: "ship", examples: ["ship", "bit", "busy", "gym"], x: 20, y: 18 },
    { ipa: "e", cue: "eh", keyword: "bed", examples: ["bed", "head", "said", "many"], x: 14, y: 42 },
    { ipa: "æ", keyword: "cat", examples: ["cat", "hand", "apple", "man"], x: 26, y: 82 },
    { ipa: "ɑː", cue: "ah", keyword: "car", examples: ["car", "father", "start", "heart"], x: 86, y: 96 },
    { ipa: "ɒ", keyword: "hot", examples: ["hot", "box", "want", "watch"], x: 97, y: 76 },
    { ipa: "ɔː", cue: "aw", keyword: "door", examples: ["door", "more", "law", "bought"], x: 94, y: 54 },
    { ipa: "ʊ", keyword: "book", examples: ["book", "good", "put", "could"], x: 76, y: 20 },
    { ipa: "uː", cue: "ooh", keyword: "food", examples: ["food", "blue", "rude", "who"], x: 96, y: 4 },
    { ipa: "ʌ", cue: "uh", keyword: "cup", examples: ["cup", "love", "son", "young"], x: 56, y: 72 },
    { ipa: "ɜː", cue: "er", keyword: "bird", examples: ["bird", "her", "turn", "learn"], x: 44, y: 46 },
    { ipa: "ə", cue: "uh", keyword: "about", examples: ["about", "sofa", "teacher", "banana"], x: 64, y: 38 },
  ],
  diphthongs: [
    { ipa: "eɪ", cue: "ay", keyword: "day", examples: ["day", "name", "rain", "eight"] },
    { ipa: "aɪ", cue: "eye", keyword: "my", examples: ["my", "time", "light", "buy"] },
    { ipa: "ɔɪ", cue: "oy", keyword: "boy", examples: ["boy", "noise", "coin", "enjoy"] },
    { ipa: "əʊ", cue: "oh", keyword: "go", examples: ["go", "home", "show", "boat"] },
    { ipa: "aʊ", cue: "ow", keyword: "now", examples: ["now", "house", "out", "down"] },
    { ipa: "ɪə", cue: "ear", keyword: "here", examples: ["here", "near", "beer", "idea"] },
    { ipa: "eə", cue: "air", keyword: "hair", examples: ["hair", "care", "there", "where"] },
    { ipa: "ʊə", keyword: "tour", examples: ["tour", "pure", "cure", "Europe"] },
  ],
};

const US: AccentChart = {
  accent: "US",
  label: "American",
  vowels: [
    { ipa: "i", cue: "ee", keyword: "sheep", examples: ["see", "sheep", "meat", "key"], x: 4, y: 4 },
    { ipa: "ɪ", cue: "ih", keyword: "ship", examples: ["ship", "bit", "busy", "gym"], x: 20, y: 18 },
    { ipa: "ɛ", cue: "eh", keyword: "bed", examples: ["bed", "head", "said", "many"], x: 14, y: 42 },
    { ipa: "æ", keyword: "cat", examples: ["cat", "hand", "apple", "man"], x: 26, y: 82 },
    { ipa: "ɑ", cue: "ah", keyword: "hot", examples: ["hot", "father", "box", "stop"], x: 88, y: 94 },
    { ipa: "ɔ", cue: "aw", keyword: "thought", examples: ["thought", "law", "dog", "bought"], x: 94, y: 56 },
    { ipa: "ʊ", keyword: "book", examples: ["book", "good", "put", "could"], x: 76, y: 20 },
    { ipa: "u", cue: "ooh", keyword: "food", examples: ["food", "blue", "rude", "who"], x: 96, y: 4 },
    { ipa: "ʌ", cue: "uh", keyword: "cup", examples: ["cup", "love", "son", "young"], x: 56, y: 72 },
    { ipa: "ɝ", cue: "er", keyword: "bird", examples: ["bird", "her", "turn", "learn"], x: 44, y: 46 },
    { ipa: "ə", cue: "uh", keyword: "about", examples: ["about", "sofa", "teacher", "banana"], x: 64, y: 38 },
  ],
  diphthongs: [
    { ipa: "eɪ", cue: "ay", keyword: "day", examples: ["day", "name", "rain", "eight"] },
    { ipa: "aɪ", cue: "eye", keyword: "my", examples: ["my", "time", "light", "buy"] },
    { ipa: "ɔɪ", cue: "oy", keyword: "boy", examples: ["boy", "noise", "coin", "enjoy"] },
    { ipa: "oʊ", cue: "oh", keyword: "go", examples: ["go", "home", "show", "boat"] },
    { ipa: "aʊ", cue: "ow", keyword: "now", examples: ["now", "house", "out", "down"] },
  ],
};

export const ACCENT_CHARTS: AccentChart[] = [GB, US];

/** 元音图的梯形边框(viewBox 0 0 100 100):上沿闭元音,左沿前元音向下内收 */
export const VOWEL_QUAD_POINTS = "0,0 100,0 100,100 30,100";

/** 辅音按发音方式分组,英美通用 */
export const CONSONANT_GROUPS: PhonemeGroup[] = [
  {
    name: "Plosives",
    hint: "Close the mouth completely, then let the air burst out.",
    items: [
      { ipa: "p", cue: "puh", keyword: "pen", examples: ["pen", "happy", "stop", "apple"] },
      { ipa: "b", cue: "buh", keyword: "bed", examples: ["bed", "about", "job", "rabbit"] },
      { ipa: "t", cue: "tuh", keyword: "tea", examples: ["tea", "letter", "light", "start"] },
      { ipa: "d", cue: "duh", keyword: "day", examples: ["day", "ladder", "red", "send"] },
      { ipa: "k", cue: "kuh", keyword: "key", examples: ["key", "school", "back", "ask"] },
      { ipa: "g", cue: "guh", keyword: "go", examples: ["go", "again", "bag", "girl"] },
    ],
  },
  {
    name: "Fricatives",
    hint: "Squeeze the air through a narrow gap — the sound can be held.",
    items: [
      { ipa: "f", cue: "fuh", keyword: "fish", examples: ["fish", "coffee", "laugh", "half"] },
      { ipa: "v", cue: "vuh", keyword: "van", examples: ["van", "love", "every", "of"] },
      { ipa: "θ", keyword: "think", examples: ["think", "three", "both", "month"] },
      { ipa: "ð", keyword: "this", examples: ["this", "mother", "other", "with"] },
      { ipa: "s", cue: "suh", keyword: "see", examples: ["see", "city", "pass", "box"] },
      { ipa: "z", cue: "zuh", keyword: "zoo", examples: ["zoo", "lazy", "is", "nose"] },
      { ipa: "ʃ", cue: "shuh", keyword: "she", examples: ["she", "ship", "nation", "fish"] },
      { ipa: "ʒ", keyword: "vision", examples: ["vision", "usual", "measure", "garage"] },
      { ipa: "h", cue: "huh", keyword: "hat", examples: ["hat", "who", "behind", "ahead"] },
    ],
  },
  {
    name: "Affricates",
    hint: "A plosive that opens straight into a fricative.",
    items: [
      { ipa: "tʃ", cue: "chuh", keyword: "chair", examples: ["chair", "church", "watch", "picture"] },
      { ipa: "dʒ", cue: "juh", keyword: "jump", examples: ["jump", "age", "bridge", "giant"] },
    ],
  },
  {
    name: "Nasals",
    hint: "The air leaves through the nose instead of the mouth.",
    items: [
      { ipa: "m", cue: "muh", keyword: "man", examples: ["man", "summer", "time", "autumn"] },
      { ipa: "n", cue: "nuh", keyword: "nose", examples: ["nose", "funny", "sun", "know"] },
      { ipa: "ŋ", keyword: "sing", examples: ["sing", "long", "think", "English"] },
    ],
  },
  {
    name: "Approximants",
    hint: "The tongue or lips narrow the mouth without ever touching.",
    items: [
      { ipa: "l", cue: "luh", keyword: "leg", examples: ["leg", "yellow", "ball", "little"] },
      { ipa: "r", cue: "ruh", keyword: "red", examples: ["red", "sorry", "write", "around"] },
      { ipa: "j", cue: "yuh", keyword: "yes", examples: ["yes", "young", "music", "few"] },
      { ipa: "w", cue: "wuh", keyword: "we", examples: ["we", "wait", "one", "quick"] },
    ],
  },
];
