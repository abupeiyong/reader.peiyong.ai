// 跟读录音:MediaRecorder 录音,同时用浏览器 SpeechRecognition 实时转写
// (作为 Workers AI Whisper 不可用时的临时回退)。

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null;
  onerror: (() => void) | null;
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export interface RecorderController {
  stop: () => Promise<{ blob: Blob; transcript: string }>;
  cancel: () => void;
}

export async function startRecording(): Promise<RecorderController> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  let transcript = "";
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  let recognition: SpeechRecognitionLike | null = null;
  if (SR) {
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) transcript += " " + e.results[i][0].transcript;
      }
    };
    recognition.onerror = () => {
      /* 忽略,继续录音 */
    };
    try {
      recognition.start();
    } catch {
      recognition = null;
    }
  }

  recorder.start(250);

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
    try {
      recognition?.stop();
    } catch {
      /* ignore */
    }
  };

  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          cleanup();
          // 给 recognition 一点时间输出最后结果
          setTimeout(() => {
            resolve({ blob: new Blob(chunks, { type: mime || "audio/webm" }), transcript: transcript.trim() });
          }, 600);
        };
        recorder.stop();
      }),
    cancel() {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      cleanup();
    },
  };
}
