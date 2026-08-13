"use client";

import { Suspense } from "react";

import { OrbView } from "@/components/OrbView";
import { ORB2 } from "@/lib/orb2";

// See app/orb1/page.tsx -- client component so OrbSpec.build() never has to
// be serialized across the server boundary.
export default function Orb2Page() {
  return (
    <Suspense fallback={null}>
      <OrbView spec={ORB2} reference="/reference/particleorb2.jpg" />
    </Suspense>
  );
}
