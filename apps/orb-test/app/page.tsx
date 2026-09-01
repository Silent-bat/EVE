import Link from "next/link";

import { ORB1 } from "@/lib/orb1";
import { ORB2 } from "@/lib/orb2";
import { ORB_EVE } from "@/lib/orbEve";

const ORBS = [
  { spec: ORB_EVE, href: "/eve" },
  { spec: ORB1, href: "/orb1" },
  { spec: ORB2, href: "/orb2" },
];

export default function Home() {
  return (
    <main className="home">
      <div className="home__head">
        <h1>Orb test</h1>
        <p>
          WebGL point-sprite recreations of particleorb1 and particleorb2. One draw call each; all motion runs
          in the vertex shader.
        </p>
      </div>

      <div className="home__grid">
        {ORBS.map(({ spec, href }) => (
          <Link key={spec.id} href={href} className="card">
            <h2 className="card__title">{spec.label}</h2>
            <p className="card__note">{spec.note}</p>
            <div className="stage" style={{ display: "grid", placeItems: "center" }}>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>open to render →</span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
