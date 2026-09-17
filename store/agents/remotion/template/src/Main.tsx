import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const Main: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 } });
  const fade = interpolate(frame, [durationInFrames - 20, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const sweep = interpolate(frame, [0, durationInFrames], [-20, 20]);
  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #0b0b0c, #1c1f2b)", justifyContent: "center", alignItems: "center", fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif", opacity: fade }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at ${50 + sweep}% 40%, rgba(90,110,255,.25), transparent 60%)` }} />
      <h1 style={{ color: "white", fontSize: 120, fontWeight: 700, margin: 0, letterSpacing: -3, transform: `translateY(${(1 - rise) * 80}px)`, opacity: rise }}>{title}</h1>
      <p style={{ color: "rgba(255,255,255,.6)", fontSize: 44, marginTop: 24, opacity: interpolate(frame, [15, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>{subtitle}</p>
    </AbsoluteFill>
  );
};
