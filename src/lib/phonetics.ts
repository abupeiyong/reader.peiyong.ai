// 音标表:英音(RP)/ 美音(GA)各一套元音与双元音,辅音两套共用。
//
// 发音怎么来:点音标放的是 Wikimedia Commons 上的 IPA 标准录音(真人发音,见下面
// RECORDINGS),不再交给 TTS —— IPA 直接丢给 TTS 会被逐字念成「slash i colon slash」,
// 退一步用「puh」这类拼法提示念出来的也不是这个音。没有标准录音的(双元音、美音 /ɝ/)
// 以及录音取不到时,才回退 TTS 念代表词 —— 那至少是个发音正确的真词。
export interface Phoneme {
  /** IPA 符号,不带两侧斜杠 */
  ipa: string;
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

// Wikimedia Commons 上的 IPA 发音录音(CC BY-SA 3.0,Denelson83 / Peter Isotalo 等录制),
// 也就是维基百科各个辅音 / 元音条目在用的那几段。取 Commons 转码出来的 mp3:原始文件是
// ogg,iOS Safari 放不了。路径里那两位是文件名 md5 的前两个字符(Commons 自己的分桶规则,
// 浏览器里算不出 md5),所以跟文件名一起写死:
//   md5("Voiceless_bilabial_plosive.ogg") = 51d9... → /5/51/<file>/<file>.mp3
function commons(bucket: string, file: string): string {
  return `https://upload.wikimedia.org/wikipedia/commons/transcoded/${bucket[0]}/${bucket}/${file}/${file}.mp3`;
}

const CLOSE_FRONT = commons("91", "Close_front_unrounded_vowel.ogg");
const CLOSE_BACK_ROUNDED = commons("5d", "Close_back_rounded_vowel.ogg");
const OPEN_BACK = commons("e5", "Open_back_unrounded_vowel.ogg");
const OPEN_MID_BACK_ROUNDED = commons("02", "Open-mid_back_rounded_vowel.ogg");

/**
 * 音标 → 标准录音。键是页面上显示的音标,所以英音 / 美音符号不同的(/iː/ 与 /i/)各记一条,
 * 符号相同的两边共用同一段录音。
 *
 * 录音录的是 IPA 的那个音,和英语音位不完全是一个东西,挑的时候按英语里的实际音值:
 * /ʌ/(STRUT)英美都更接近央元音 [ɐ] 而不是基本元音 [ʌ],/r/ 是齿后的 [ɹ̠] 而不是齿龈的 [ɹ]。
 * 辅音录的是夹在元音之间的那个音([aCa]),这也是维基百科音系条目的惯例。
 */
const RECORDINGS: Record<string, string> = {
  // 单元音
  "iː": CLOSE_FRONT,
  "i": CLOSE_FRONT,
  "ɪ": commons("4c", "Near-close_near-front_unrounded_vowel.ogg"),
  "e": commons("6c", "Close-mid_front_unrounded_vowel.ogg"),
  "ɛ": commons("71", "Open-mid_front_unrounded_vowel.ogg"),
  "æ": commons("c9", "Near-open_front_unrounded_vowel.ogg"),
  "ɑː": OPEN_BACK,
  "ɑ": OPEN_BACK,
  "ɒ": commons("0a", "Open_back_rounded_vowel.ogg"),
  "ɔː": OPEN_MID_BACK_ROUNDED,
  "ɔ": OPEN_MID_BACK_ROUNDED,
  "ʊ": commons("d5", "Near-close_near-back_rounded_vowel.ogg"),
  "uː": CLOSE_BACK_ROUNDED,
  "u": CLOSE_BACK_ROUNDED,
  "ʌ": commons("22", "Near-open_central_unrounded_vowel.ogg"),
  "ɜː": commons("01", "Open-mid_central_unrounded_vowel.ogg"),
  "ə": commons("d9", "Mid-central_vowel.ogg"),
  // 辅音
  "p": commons("51", "Voiceless_bilabial_plosive.ogg"),
  "b": commons("2c", "Voiced_bilabial_plosive.ogg"),
  "t": commons("02", "Voiceless_alveolar_plosive.ogg"),
  "d": commons("01", "Voiced_alveolar_plosive.ogg"),
  "k": commons("e3", "Voiceless_velar_plosive.ogg"),
  "g": commons("b4", "Voiced_velar_plosive.ogg"),
  "f": commons("33", "Voiceless_labiodental_fricative.ogg"),
  "v": commons("85", "Voiced_labiodental_fricative.ogg"),
  "θ": commons("80", "Voiceless_dental_fricative.ogg"),
  "ð": commons("6a", "Voiced_dental_fricative.ogg"),
  "s": commons("ac", "Voiceless_alveolar_sibilant.ogg"),
  "z": commons("c0", "Voiced_alveolar_sibilant.ogg"),
  "ʃ": commons("cc", "Voiceless_palato-alveolar_sibilant.ogg"),
  "ʒ": commons("30", "Voiced_palato-alveolar_sibilant.ogg"),
  "h": commons("da", "Voiceless_glottal_fricative.ogg"),
  "tʃ": commons("97", "Voiceless_palato-alveolar_affricate.ogg"),
  "dʒ": commons("e6", "Voiced_palato-alveolar_affricate.ogg"),
  "m": commons("a9", "Bilabial_nasal.ogg"),
  "n": commons("29", "Alveolar_nasal.ogg"),
  "ŋ": commons("39", "Velar_nasal.ogg"),
  "l": commons("bc", "Alveolar_lateral_approximant.ogg"),
  "r": commons("33", "Postalveolar_approximant.ogg"),
  "j": commons("e8", "Palatal_approximant.ogg"),
  "w": commons("f2", "Voiced_labio-velar_approximant.ogg"),
};

/** 这个音标的标准录音;没有录音的(双元音、美音 /ɝ/)返回 undefined,由调用方兜底 */
export function phonemeRecording(ipa: string): string | undefined {
  return RECORDINGS[ipa];
}

/** 录音来源,页面上要署名(CC BY-SA 要求) */
export const RECORDING_CREDIT = {
  text: "Wikimedia Commons · CC BY-SA 3.0",
  href: "https://commons.wikimedia.org/wiki/Category:Phonemes",
};

const GB: AccentChart = {
  accent: "GB",
  label: "British",
  vowels: [
    { ipa: "iː", keyword: "sheep", examples: ["see", "sheep", "meat", "key"], x: 4, y: 4 },
    { ipa: "ɪ", keyword: "ship", examples: ["ship", "bit", "busy", "gym"], x: 20, y: 18 },
    { ipa: "e", keyword: "bed", examples: ["bed", "head", "said", "many"], x: 14, y: 42 },
    { ipa: "æ", keyword: "cat", examples: ["cat", "hand", "apple", "man"], x: 26, y: 82 },
    { ipa: "ɑː", keyword: "car", examples: ["car", "father", "start", "heart"], x: 86, y: 96 },
    { ipa: "ɒ", keyword: "hot", examples: ["hot", "box", "want", "watch"], x: 97, y: 76 },
    { ipa: "ɔː", keyword: "door", examples: ["door", "more", "law", "bought"], x: 94, y: 54 },
    { ipa: "ʊ", keyword: "book", examples: ["book", "good", "put", "could"], x: 76, y: 20 },
    { ipa: "uː", keyword: "food", examples: ["food", "blue", "rude", "who"], x: 96, y: 4 },
    { ipa: "ʌ", keyword: "cup", examples: ["cup", "love", "son", "young"], x: 56, y: 72 },
    { ipa: "ɜː", keyword: "bird", examples: ["bird", "her", "turn", "learn"], x: 44, y: 46 },
    { ipa: "ə", keyword: "about", examples: ["about", "sofa", "teacher", "banana"], x: 64, y: 38 },
  ],
  diphthongs: [
    { ipa: "eɪ", keyword: "day", examples: ["day", "name", "rain", "eight"] },
    { ipa: "aɪ", keyword: "my", examples: ["my", "time", "light", "buy"] },
    { ipa: "ɔɪ", keyword: "boy", examples: ["boy", "noise", "coin", "enjoy"] },
    { ipa: "əʊ", keyword: "go", examples: ["go", "home", "show", "boat"] },
    { ipa: "aʊ", keyword: "now", examples: ["now", "house", "out", "down"] },
    { ipa: "ɪə", keyword: "here", examples: ["here", "near", "beer", "idea"] },
    { ipa: "eə", keyword: "hair", examples: ["hair", "care", "there", "where"] },
    { ipa: "ʊə", keyword: "tour", examples: ["tour", "pure", "cure", "Europe"] },
  ],
};

const US: AccentChart = {
  accent: "US",
  label: "American",
  vowels: [
    { ipa: "i", keyword: "sheep", examples: ["see", "sheep", "meat", "key"], x: 4, y: 4 },
    { ipa: "ɪ", keyword: "ship", examples: ["ship", "bit", "busy", "gym"], x: 20, y: 18 },
    { ipa: "ɛ", keyword: "bed", examples: ["bed", "head", "said", "many"], x: 14, y: 42 },
    { ipa: "æ", keyword: "cat", examples: ["cat", "hand", "apple", "man"], x: 26, y: 82 },
    { ipa: "ɑ", keyword: "hot", examples: ["hot", "father", "box", "stop"], x: 88, y: 94 },
    { ipa: "ɔ", keyword: "thought", examples: ["thought", "law", "dog", "bought"], x: 94, y: 56 },
    { ipa: "ʊ", keyword: "book", examples: ["book", "good", "put", "could"], x: 76, y: 20 },
    { ipa: "u", keyword: "food", examples: ["food", "blue", "rude", "who"], x: 96, y: 4 },
    { ipa: "ʌ", keyword: "cup", examples: ["cup", "love", "son", "young"], x: 56, y: 72 },
    { ipa: "ɝ", keyword: "bird", examples: ["bird", "her", "turn", "learn"], x: 44, y: 46 },
    { ipa: "ə", keyword: "about", examples: ["about", "sofa", "teacher", "banana"], x: 64, y: 38 },
  ],
  diphthongs: [
    { ipa: "eɪ", keyword: "day", examples: ["day", "name", "rain", "eight"] },
    { ipa: "aɪ", keyword: "my", examples: ["my", "time", "light", "buy"] },
    { ipa: "ɔɪ", keyword: "boy", examples: ["boy", "noise", "coin", "enjoy"] },
    { ipa: "oʊ", keyword: "go", examples: ["go", "home", "show", "boat"] },
    { ipa: "aʊ", keyword: "now", examples: ["now", "house", "out", "down"] },
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
      { ipa: "p", keyword: "pen", examples: ["pen", "happy", "stop", "apple"] },
      { ipa: "b", keyword: "bed", examples: ["bed", "about", "job", "rabbit"] },
      { ipa: "t", keyword: "tea", examples: ["tea", "letter", "light", "start"] },
      { ipa: "d", keyword: "day", examples: ["day", "ladder", "red", "send"] },
      { ipa: "k", keyword: "key", examples: ["key", "school", "back", "ask"] },
      { ipa: "g", keyword: "go", examples: ["go", "again", "bag", "girl"] },
    ],
  },
  {
    name: "Fricatives",
    hint: "Squeeze the air through a narrow gap — the sound can be held.",
    items: [
      { ipa: "f", keyword: "fish", examples: ["fish", "coffee", "laugh", "half"] },
      { ipa: "v", keyword: "van", examples: ["van", "love", "every", "of"] },
      { ipa: "θ", keyword: "think", examples: ["think", "three", "both", "month"] },
      { ipa: "ð", keyword: "this", examples: ["this", "mother", "other", "with"] },
      { ipa: "s", keyword: "see", examples: ["see", "city", "pass", "box"] },
      { ipa: "z", keyword: "zoo", examples: ["zoo", "lazy", "is", "nose"] },
      { ipa: "ʃ", keyword: "she", examples: ["she", "ship", "nation", "fish"] },
      { ipa: "ʒ", keyword: "vision", examples: ["vision", "usual", "measure", "garage"] },
      { ipa: "h", keyword: "hat", examples: ["hat", "who", "behind", "ahead"] },
    ],
  },
  {
    name: "Affricates",
    hint: "A plosive that opens straight into a fricative.",
    items: [
      { ipa: "tʃ", keyword: "chair", examples: ["chair", "church", "watch", "picture"] },
      { ipa: "dʒ", keyword: "jump", examples: ["jump", "age", "bridge", "giant"] },
    ],
  },
  {
    name: "Nasals",
    hint: "The air leaves through the nose instead of the mouth.",
    items: [
      { ipa: "m", keyword: "man", examples: ["man", "summer", "time", "autumn"] },
      { ipa: "n", keyword: "nose", examples: ["nose", "funny", "sun", "know"] },
      { ipa: "ŋ", keyword: "sing", examples: ["sing", "long", "think", "English"] },
    ],
  },
  {
    name: "Approximants",
    hint: "The tongue or lips narrow the mouth without ever touching.",
    items: [
      { ipa: "l", keyword: "leg", examples: ["leg", "yellow", "ball", "little"] },
      { ipa: "r", keyword: "red", examples: ["red", "sorry", "write", "around"] },
      { ipa: "j", keyword: "yes", examples: ["yes", "young", "music", "few"] },
      { ipa: "w", keyword: "we", examples: ["we", "wait", "one", "quick"] },
    ],
  },
];
