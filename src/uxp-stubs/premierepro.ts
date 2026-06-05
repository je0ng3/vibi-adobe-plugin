// Browser-preview stand-in for the Premiere Pro API. The real plugin gets these from the host
// (see src/uxp-shim/premierepro.ts). Here we expose a small fake project tree so the project
// browser renders representative rows (audio + video) during `npm run dev` preview.
interface FakeClip {
  name: string;
  mediaPath: string;
  __clip: true;
  getMediaFilePath: () => Promise<string>;
}

const SAMPLE_MEDIA = [
  { name: "Interview_Final_Mix.wav", mediaPath: "/preview/Interview_Final_Mix.wav" },
  { name: "Podcast_ep12_master.mp3", mediaPath: "/preview/Podcast_ep12_master.mp3" },
  { name: "B-Roll_Drone_4K.mp4", mediaPath: "/preview/B-Roll_Drone_4K.mp4" },
  { name: "Interview_Cam_A.mov", mediaPath: "/preview/Interview_Cam_A.mov" },
];

function fakeClip(o: { name: string; mediaPath: string }): FakeClip {
  return { ...o, __clip: true, async getMediaFilePath() { return o.mediaPath; } };
}

export const Project = {
  async getActiveProject() {
    return {
      async getRootItem() {
        return {
          name: "root",
          async getItems() {
            return SAMPLE_MEDIA.map(fakeClip);
          },
        };
      },
    };
  },
};

export const ClipProjectItem = {
  cast(item: unknown): FakeClip | null {
    return item && (item as FakeClip).__clip ? (item as FakeClip) : null;
  },
};
