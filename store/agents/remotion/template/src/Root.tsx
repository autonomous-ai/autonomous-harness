import React from "react";
import { Composition } from "remotion";
import { Main } from "./Main";

export const Root: React.FC = () => (
  <>
    <Composition
      id="Main"
      component={Main}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ title: "Say it with motion", subtitle: "a Remotion video, written as you watch" }}
    />
  </>
);
