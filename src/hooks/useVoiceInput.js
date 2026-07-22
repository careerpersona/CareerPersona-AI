import { useState, useRef, useCallback, useEffect } from "react";

const getSR = () =>
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

// Returns true when the current browser supports the Web Speech API.
// Used by callers to conditionally render the voice input button.
export const voiceSupported = () => !!getSR();

// Manages a single SpeechRecognition session.
//
// `lang`        — BCP-47 language tag passed directly to SpeechRecognition
//                 (e.g. "en", "fr", "de"). The browser normalises it.
// `onTranscript` — called on every interim and final result with the full
//                 accumulated transcript string (base text + voice text).
//
// Returns { status, errorCode, start, stop }.
//   status    : "idle" | "recording" | "error"
//   errorCode : null | "permission-denied" | "no-microphone" | "no-speech"
//               | "not-supported" | "error"
//   start(currentText) : begin recording; `currentText` is prepended to the
//                        transcript so existing typed text is preserved.
//   stop()             : end recording immediately.
export function useVoiceInput({ lang = "en-US", onTranscript } = {}) {
  const [status, setStatus] = useState("idle");
  const [errorCode, setErrorCode] = useState(null);

  const recognitionRef = useRef(null);
  const baseTextRef = useRef("");

  // Keep onTranscript stable across renders without adding it as a dep of start().
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);

  const stop = useCallback(() => {
    const r = recognitionRef.current;
    if (r) { r.stop(); recognitionRef.current = null; }
    setStatus("idle");
  }, []);

  const start = useCallback((currentText = "") => {
    const SR = getSR();
    if (!SR) { setErrorCode("not-supported"); setStatus("error"); return; }
    if (recognitionRef.current) return; // already recording

    baseTextRef.current = typeof currentText === "string" ? currentText.trimEnd() : "";
    setErrorCode(null);
    setStatus("recording");

    const r = new SR();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      // Loop from 0 each time — with continuous mode, all results accumulate in
      // event.results so rebuilding from scratch is both correct and simple.
      let finals = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) {
          finals = finals ? finals + " " + text : text;
        } else {
          interim = text;
        }
      }
      const voicePart = [finals, interim].filter(Boolean).join(" ");
      const base = baseTextRef.current;
      const transcript = base ? (voicePart ? base + " " + voicePart : base) : voicePart;
      onTranscriptRef.current?.(transcript);
    };

    r.onerror = (event) => {
      const code =
        event.error === "not-allowed" || event.error === "permission-denied" ? "permission-denied" :
        event.error === "audio-capture" ? "no-microphone" :
        event.error === "no-speech" ? "no-speech" : "error";
      setErrorCode(code);
      setStatus("error");
      recognitionRef.current = null;
    };

    r.onend = () => {
      // onend fires both on explicit stop() and on auto-stop (e.g. iOS Safari,
      // silence timeout). Only transition to idle when this is our active instance.
      if (recognitionRef.current === r) {
        recognitionRef.current = null;
        setStatus("idle");
      }
    };

    recognitionRef.current = r;
    try {
      r.start();
    } catch {
      setErrorCode("error");
      setStatus("error");
      recognitionRef.current = null;
    }
  }, [lang]);

  // Abort any in-progress recognition when the component unmounts.
  useEffect(() => {
    return () => { recognitionRef.current?.abort(); };
  }, []);

  return { status, errorCode, start, stop };
}
