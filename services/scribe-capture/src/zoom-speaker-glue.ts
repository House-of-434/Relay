export interface ZoomSpeakerSink {
  onSpeak(name: string | null, tMs: number, isEnd: boolean): void;
}

export function createZoomSpeakerGlue(sink: ZoomSpeakerSink): (name: string | null, now: number) => void {
  let last: string | null = null;
  return (name: string | null, now: number): void => {
    if (name === null) {
      if (last !== null) {
        sink.onSpeak(last, now, true);
        last = null;
      }
      return;
    }
    sink.onSpeak(name, now, false);
    last = name;
  };
}
