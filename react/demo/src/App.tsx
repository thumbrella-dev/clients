import { Thumbnail, Thumbrella } from "@thumbrella/react";

const DEMO = "https://demo.thumbrella.dev";

export default function App() {
  return (
    <Thumbrella connect={DEMO}>
      <div className="grid">
        <Thumbnail src={DEMO + "/media/neon-block.png"} alt="neon-block" />
        <Thumbnail src={DEMO + "/media/space-colony.jpg"} alt="space-colony" />
        <Thumbnail src={DEMO + "/media/stanford-bunny.stl"} alt="stanford-bunny" />
        <Thumbnail src={DEMO + "/media/harbor-trucks.mp4"} alt="harbor-trucks" />
      </div>
    </Thumbrella>
  );
}
