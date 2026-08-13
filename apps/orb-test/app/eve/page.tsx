"use client";

import { Suspense } from "react";

import { OrbView } from "@/components/OrbView";
import { ORB_EVE } from "@/lib/orbEve";

// Client component: OrbSpec carries build() and solvePointBase(), and functions
// cannot cross the server -> client boundary. Importing the spec inside the
// client bundle sidesteps serialization entirely.
export default function EvePage() {
  return (
    <Suspense fallback={null}>
      <OrbView spec={ORB_EVE} reference="/reference/particleorb1.jpeg" />
    </Suspense>
  );
}
