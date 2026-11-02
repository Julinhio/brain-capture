import { useCallback, useEffect, useRef, useState } from 'react';

export const MAX_RECORDING_MS = 10 * 60 * 1000;
const LEVEL_BARS = 36;

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  /** Set when the recording ended on its own (time limit, app sent to background, mic lost). */
  endedBecause: 'limit' | 'interrupted' | null;
}

export type RecorderError = 'permission-denied' | 'no-microphone' | 'unsupported' | 'failed';

type State = { name: 'idle' } | { name: 'starting' } | { name: 'recording'; startedAt: number } | { name: 'error'; error: RecorderError };

function pickMimeType(): string {
  // Chrome on Android records Opus in WebM; Safari only does AAC in MP4.
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * Microphone recording with a live level meter. The audio stays in memory here and is
 * handed to the outbox on stop; nothing is uploaded while recording.
 */
export function useRecorder(onFinished: (recording: Recording) => void) {
  const [state, setState] = useState<State>({ name: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(LEVEL_BARS).fill(0));

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const discardRef = useRef(false);
  const endReasonRef = useRef<Recording['endedBecause']>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const stop = useCallback((reason: Recording['endedBecause'] = null) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    endReasonRef.current = reason;
    recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState({ name: 'error', error: 'unsupported' });
      return;
    }
    setState({ name: 'starting' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException).name;
      setState({
        name: 'error',
        error: name === 'NotAllowedError' || name === 'SecurityError' ? 'permission-denied' : name === 'NotFoundError' ? 'no-microphone' : 'failed',
      });
      return;
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;
    endReasonRef.current = null;

    // Level meter: RMS of the waveform, sampled a dozen times a second (enough to look alive,
    // cheap enough to keep the main thread free).
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioCtx();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const meter = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += ((s - 128) / 128) ** 2;
      const rms = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      setLevels((prev) => [...prev.slice(1), rms]);
      const ms = performance.now() - startedRef.current;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) stop('limit');
    }, 80);

    let wakeLock: WakeLockSentinel | null = null;
    navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => undefined);

    // Leaving the app (call, app switch) or losing the mic ends the recording and keeps what
    // was said so far, rather than silently recording nothing in the background.
    const onHidden = () => document.visibilityState === 'hidden' && stop('interrupted');
    document.addEventListener('visibilitychange', onHidden);
    const track = stream.getAudioTracks()[0];
    const onTrackEnded = () => stop('interrupted');
    track?.addEventListener('ended', onTrackEnded);

    cleanupRef.current = () => {
      window.clearInterval(meter);
      document.removeEventListener('visibilitychange', onHidden);
      track?.removeEventListener('ended', onTrackEnded);
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close().catch(() => undefined);
      void wakeLock?.release().catch(() => undefined);
      cleanupRef.current = null;
    };

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => stop('interrupted');
    recorder.onstop = () => {
      const durationMs = Math.min(performance.now() - startedRef.current, MAX_RECORDING_MS);
      cleanupRef.current?.();
      recorderRef.current = null;
      setState({ name: 'idle' });
      setElapsed(0);
      setLevels(Array(LEVEL_BARS).fill(0));
      if (discardRef.current) return;
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (blob.size === 0) return;
      finishedRef.current({ blob, mimeType: type, durationMs, endedBecause: endReasonRef.current });
    };

    // A timeslice makes the browser hand over data every second, so an abrupt end still
    // leaves everything recorded up to that point.
    recorder.start(1000);
    startedRef.current = performance.now();
    setState({ name: 'recording', startedAt: Date.now() });
  }, [stop]);

  // Unmounting mid-recording (navigation) throws the take away rather than leaking the mic.
  useEffect(
    () => () => {
      discardRef.current = true;
      recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop();
      cleanupRef.current?.();
    },
    [],
  );

  return {
    state,
    elapsed,
    levels,
    start,
    stop: () => stop(null),
    cancel,
    reset: () => setState({ name: 'idle' }),
  };
}
