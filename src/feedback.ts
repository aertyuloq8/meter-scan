let audioContext: AudioContext | null = null;

export function playBeep(frequency = 880, durationMs = 130): void {
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }
      audioContext = new AudioContextClass();
    }

    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    gain.gain.setValueAtTime(0.08, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + durationMs / 1000);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + durationMs / 1000);
  } catch {
    // audio unavailable
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // vibration unavailable
  }
}

export function feedbackSuccess(): void {
  playBeep(880);
  vibrate(60);
}

export function feedbackDuplicate(): void {
  playBeep(440, 150);
  vibrate([40, 60, 40]);
}

export function feedbackError(): void {
  playBeep(220, 200);
  vibrate(100);
}