"use client";

import { Suspense } from "react";

import { OrbView } from "@/components/OrbView";
import { ORB1 } from "@/lib/orb1";

// Client component: OrbSpec carries a build() function, and functions cannot
// cross the server -> client boundary. Importing the spec inside the client
// bundle sidesteps serialization entirely.
export default function Orb1Page() {
  return (
    <Suspense fallback={null}>
      <OrbView spec={ORB1} reference="/reference/particleorb1.jpeg" />
    </Suspense>
  );
}
