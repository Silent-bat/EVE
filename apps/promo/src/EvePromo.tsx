import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  Solid,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const C = {
  black: "#000000",
  ink: "#171526",
  paper: "#f7f7f4",
  white: "#ffffff",
  gray: "#777582",
  line: "#dedde4",
  purple: "#7656e8",
  violet: "#a88cff",
  cyan: "#22bde9",
  mint: "#22c995",
  coral: "#e66f75",
};

const font = "Inter, SF Pro Display, Arial, sans-serif";

const fade = (frame: number, duration: number, edge = 15) =>
  interpolate(frame, [0, edge, duration - edge, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const enter = (frame: number, fps: number, delay = 0, distance = 54) => {
  const progress = spring({ frame: frame - delay, fps, config: { damping: 18, stiffness: 105, mass: 0.9 } });
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
};

const scaleIn = (frame: number, fps: number, delay = 0) => {
  const progress = spring({ frame: frame - delay, fps, config: { damping: 16, stiffness: 90 } });
  return {
    opacity: progress,
    transform: `scale(${0.82 + progress * 0.18})`,
  };
};

const Backdrop = ({ dark = false, children }: { dark?: boolean; children?: ReactNode }) => (
  <AbsoluteFill style={{ overflow: "hidden" }}>
    <Solid width={1080} height={1920} color={dark ? C.black : C.paper} />
    <AbsoluteFill
      style={{
        backgroundImage: dark
          ? "linear-gradient(#ffffff08 1px, transparent 1px), linear-gradient(90deg, #ffffff08 1px, transparent 1px)"
          : "linear-gradient(#17152608 1px, transparent 1px), linear-gradient(90deg, #17152608 1px, transparent 1px)",
        backgroundSize: "72px 72px",
      }}
    >
      {children}
    </AbsoluteFill>
  </AbsoluteFill>
);

const Kicker = ({ children, light = false }: { children: ReactNode; light?: boolean }) => (
  <div
    style={{
      fontFamily: font,
      fontSize: 25,
      fontWeight: 800,
      letterSpacing: 0,
      textTransform: "uppercase",
      color: light ? C.violet : C.purple,
    }}
  >
    {children}
  </div>
);

const AppMark = ({ size = 120 }: { size?: number }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.27,
      overflow: "hidden",
      boxShadow: `0 18px 60px #7656e84d`,
    }}
  >
    <Img src={staticFile("eve-icon.png")} style={{ width: "100%", height: "100%" }} />
  </div>
);

const MomentCard = ({
  time,
  title,
  copy,
  color,
  index,
}: {
  time: string;
  title: string;
  copy: string;
  color: string;
  index: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        ...enter(frame, fps, 18 + index * 18, 70),
        width: 900,
        minHeight: 220,
        padding: "32px 36px",
        borderTop: `2px solid ${C.line}`,
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        alignItems: "center",
        fontFamily: font,
      }}
    >
      <div>
        <div style={{ fontSize: 26, fontWeight: 820, color }}>{time}</div>
        <div style={{ width: 74, height: 6, marginTop: 14, background: color }} />
      </div>
      <div>
        <div style={{ fontSize: 48, lineHeight: 1.05, fontWeight: 880, color: C.ink }}>{title}</div>
        <div style={{ marginTop: 12, fontSize: 28, lineHeight: 1.3, fontWeight: 520, color: C.gray }}>
          {copy}
        </div>
      </div>
    </div>
  );
};

const OpeningScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = interpolate(frame, [42, 95], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 120, 12), fontFamily: font }}>
      <Backdrop dark>
        <div style={{ position: "absolute", left: 62, top: 130, ...enter(frame, fps, 0) }}>
          <Kicker light>What changes?</Kicker>
        </div>
        <div style={{ position: "absolute", left: 62, right: 62, top: 360 }}>
          <div
            style={{
              ...enter(frame, fps, 8, 70),
              color: C.white,
              fontSize: 116,
              lineHeight: 0.97,
              fontWeight: 930,
            }}
          >
            Independence
            <br />
            lives in the
            <br />
            small moments.
          </div>
          <div
            style={{ width: `${line * 100}%`, height: 8, maxWidth: 890, background: C.purple, marginTop: 54 }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 66,
            right: 66,
            bottom: 170,
            display: "flex",
            alignItems: "center",
            gap: 25,
            ...enter(frame, fps, 70, 30),
          }}
        >
          <AppMark size={78} />
          <div style={{ color: "#c7c5ce", fontSize: 28, lineHeight: 1.35, fontWeight: 600 }}>
            The confidence to move through a day
            <br />
            on your own terms.
          </div>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const MomentsScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 300), fontFamily: font }}>
      <Backdrop>
        <div style={{ position: "absolute", left: 70, right: 70, top: 110, ...enter(frame, fps, 0) }}>
          <Kicker>Everyday independence</Kicker>
          <div style={{ marginTop: 22, color: C.ink, fontSize: 80, lineHeight: 1.02, fontWeight: 920 }}>
            Small tasks.
            <br />A world of difference.
          </div>
        </div>
        <div style={{ position: "absolute", left: 70, top: 560 }}>
          <MomentCard
            time="8:00 AM"
            title="Remember"
            copy="A medication reminder arrives at the right moment."
            color={C.coral}
            index={0}
          />
          <MomentCard
            time="12:15 PM"
            title="Connect"
            copy="A call is answered without searching through the phone."
            color={C.cyan}
            index={1}
          />
          <MomentCard
            time="4:40 PM"
            title="Keep moving"
            copy="A message is sent, a plan stays on track."
            color={C.mint}
            index={2}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 70,
            right: 70,
            bottom: 105,
            fontSize: 34,
            fontWeight: 720,
            color: C.ink,
            ...enter(frame, fps, 92, 28),
          }}
        >
          Without needing to ask someone else first.
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const ProductPhone = ({ progress }: { progress: number }) => (
  <div
    style={{
      width: 520,
      height: 1150,
      padding: 17,
      borderRadius: 72,
      background: "#17151f",
      boxShadow: "0 55px 120px #00000066",
      transform: `translateY(${(1 - progress) * 150}px) rotate(${(1 - progress) * 7 - 3}deg) scale(${0.84 + progress * 0.16})`,
      opacity: progress,
    }}
  >
    <div style={{ width: "100%", height: "100%", overflow: "hidden", borderRadius: 56, background: C.paper }}>
      <Img
        src={staticFile("eve-dashboard.png")}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  </div>
);

const RevealScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const phone = spring({ frame: frame - 8, fps, config: { damping: 19, stiffness: 75 } });
  const orbPulse = 1 + Math.sin(frame / 15) * 0.025;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 210), fontFamily: font }}>
      <Backdrop dark>
        <div style={{ position: "absolute", left: 60, top: 115, ...enter(frame, fps, 0) }}>
          <Kicker light>Meet EVE</Kicker>
          <div
            style={{
              marginTop: 24,
              width: 610,
              color: C.white,
              fontSize: 83,
              lineHeight: 1.01,
              fontWeight: 920,
            }}
          >
            An AI assistant that lives where life happens.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: -140,
            top: 810,
            width: 720,
            height: 720,
            borderRadius: "50%",
            overflow: "hidden",
            transform: `scale(${orbPulse})`,
            opacity: 0.72,
          }}
        >
          <Img
            src={staticFile("eve-orb.jpg")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: "50%",
              mixBlendMode: "screen",
            }}
          />
        </div>
        <div style={{ position: "absolute", right: -25, top: 550 }}>
          <ProductPhone progress={phone} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 68,
            bottom: 145,
            width: 420,
            color: "#c7c5ce",
            fontSize: 30,
            lineHeight: 1.35,
            fontWeight: 580,
            ...enter(frame, fps, 58, 32),
          }}
        >
          On the phone you already use. Ready when you speak.
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const PhoneFrame = ({
  label,
  accent,
  children,
  style,
}: {
  label: string;
  accent: string;
  children: ReactNode;
  style?: CSSProperties;
}) => (
  <div style={{ position: "absolute", width: 400, ...style }}>
    <div
      style={{
        fontFamily: font,
        fontSize: 22,
        fontWeight: 840,
        color: C.gray,
        marginBottom: 18,
        textAlign: "center",
      }}
    >
      {label}
    </div>
    <div
      style={{
        width: 400,
        height: 880,
        padding: 14,
        borderRadius: 58,
        background: C.ink,
        boxShadow: "0 35px 80px #1715262b",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          borderRadius: 46,
          background: C.white,
        }}
      >
        <div
          style={{
            height: 74,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 24px",
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: accent }} />
            <span style={{ fontFamily: font, color: C.ink, fontSize: 23, fontWeight: 850 }}>EVE</span>
          </div>
          <span style={{ fontFamily: font, color: C.gray, fontSize: 17, fontWeight: 650 }}>Connected</span>
        </div>
        {children}
      </div>
    </div>
  </div>
);

const ChatBubble = ({
  children,
  active = false,
  delay = 0,
}: {
  children: ReactNode;
  active?: boolean;
  delay?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        ...enter(frame, fps, delay, 34),
        alignSelf: active ? "flex-end" : "flex-start",
        maxWidth: 310,
        padding: "20px 22px",
        borderRadius: 24,
        background: active ? C.purple : "#f0eff4",
        color: active ? C.white : C.ink,
        fontFamily: font,
        fontSize: 22,
        lineHeight: 1.28,
        fontWeight: 650,
      }}
    >
      {children}
    </div>
  );
};

const ConnectedScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leftPhone = spring({ frame: frame - 8, fps, config: { damping: 18, stiffness: 82 } });
  const rightPhone = spring({ frame: frame - 20, fps, config: { damping: 18, stiffness: 82 } });
  const link = interpolate(frame, [65, 115], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pulse = 0.75 + Math.sin(frame / 8) * 0.2;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 525), fontFamily: font }}>
      <Backdrop>
        <div style={{ position: "absolute", left: 64, right: 64, top: 86, ...enter(frame, fps, 0) }}>
          <Kicker>Trusted connection</Kicker>
          <div style={{ marginTop: 18, color: C.ink, fontSize: 76, lineHeight: 1.02, fontWeight: 920 }}>
            Your EVE can be there,
            <br />
            even when you cannot.
          </div>
          <div
            style={{
              marginTop: 28,
              display: "inline-flex",
              alignItems: "center",
              gap: 13,
              padding: "13px 18px",
              border: `1px solid ${C.line}`,
              background: C.white,
              borderRadius: 12,
            }}
          >
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: C.mint }} />
            <span style={{ color: C.ink, fontSize: 21, fontWeight: 760 }}>Approved by both people</span>
          </div>
        </div>

        <PhoneFrame
          label="YOUR EVE"
          accent={C.purple}
          style={{
            left: 60,
            top: 550,
            opacity: leftPhone,
            transform: `translateX(${(1 - leftPhone) * -120}px) rotate(-2deg)`,
          }}
        >
          <div
            style={{
              height: "calc(100% - 74px)",
              display: "flex",
              flexDirection: "column",
              gap: 18,
              padding: "34px 24px",
            }}
          >
            <div style={{ color: C.gray, fontSize: 18, fontWeight: 720 }}>Helping Mom</div>
            <ChatBubble active delay={40}>
              Remind Mom to take her medication at 8 PM.
            </ChatBubble>
            <ChatBubble delay={115}>Reminder scheduled on Mom&apos;s phone.</ChatBubble>
            <ChatBubble active delay={205}>
              Call her after the reminder.
            </ChatBubble>
            <div
              style={{
                marginTop: "auto",
                padding: "18px 20px",
                borderRadius: 18,
                background: "#f5f3fb",
                border: `1px solid #ded7f5`,
                color: C.purple,
                fontSize: 19,
                lineHeight: 1.3,
                fontWeight: 740,
              }}
            >
              Support from anywhere.
            </div>
          </div>
        </PhoneFrame>

        <PhoneFrame
          label="MOM'S EVE"
          accent={C.mint}
          style={{
            right: 60,
            top: 550,
            opacity: rightPhone,
            transform: `translateX(${(1 - rightPhone) * 120}px) rotate(2deg)`,
          }}
        >
          <div
            style={{
              height: "calc(100% - 74px)",
              padding: "34px 24px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ color: C.gray, fontSize: 18, fontWeight: 720 }}>Good evening, Rose</div>
            <div
              style={{
                marginTop: 35,
                padding: "28px 24px",
                borderRadius: 30,
                background: "#f2fff9",
                border: `2px solid ${C.mint}`,
                ...enter(frame, fps, 126, 48),
              }}
            >
              <div style={{ color: C.mint, fontSize: 19, fontWeight: 840 }}>8:00 PM</div>
              <div style={{ marginTop: 12, color: C.ink, fontSize: 31, lineHeight: 1.08, fontWeight: 880 }}>
                Time for your medication.
              </div>
              <div
                style={{
                  marginTop: 24,
                  padding: "16px 18px",
                  borderRadius: 16,
                  background: C.mint,
                  color: C.white,
                  textAlign: "center",
                  fontSize: 20,
                  fontWeight: 820,
                }}
              >
                I&apos;VE TAKEN IT
              </div>
            </div>
            <div
              style={{
                marginTop: 22,
                padding: "22px",
                borderRadius: 24,
                background: "#f3f3f6",
                ...enter(frame, fps, 220, 38),
              }}
            >
              <div style={{ color: C.gray, fontSize: 17, fontWeight: 720 }}>UP NEXT</div>
              <div style={{ marginTop: 9, color: C.ink, fontSize: 25, fontWeight: 820 }}>Call from Maya</div>
            </div>
            <div
              style={{
                marginTop: "auto",
                display: "flex",
                alignItems: "center",
                gap: 13,
                color: C.gray,
                fontSize: 18,
                fontWeight: 680,
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: C.mint }} />
              EVE is ready to help
            </div>
          </div>
        </PhoneFrame>

        <div
          style={{
            position: "absolute",
            left: 470,
            top: 1025,
            width: 140,
            height: 4,
            background: `linear-gradient(90deg, ${C.purple}, ${C.mint})`,
            transform: `scaleX(${link})`,
            transformOrigin: "left center",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 533,
            top: 1002,
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: C.white,
            border: `3px solid ${C.purple}`,
            opacity: link,
            boxShadow: `0 0 ${30 * pulse}px #7656e866`,
            display: "grid",
            placeItems: "center",
            color: C.purple,
            fontSize: 24,
            fontWeight: 900,
          }}
        >
          ↔
        </div>

        <div
          style={{
            position: "absolute",
            left: 70,
            right: 70,
            bottom: 85,
            color: C.ink,
            fontSize: 33,
            lineHeight: 1.3,
            fontWeight: 720,
            textAlign: "center",
            ...enter(frame, fps, 280, 24),
          }}
        >
          Help with reminders, calls, messages, and the next important step,
          <br />
          without taking away independence.
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const Waveform = ({ frame }: { frame: number }) => (
  <div style={{ height: 78, display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
    {Array.from({ length: 28 }, (_, index) => {
      const height = 13 + Math.abs(Math.sin(frame / 4 + index * 0.72)) * 58;
      return (
        <span
          key={index}
          style={{
            width: 7,
            height,
            borderRadius: 8,
            background: index % 3 === 0 ? C.cyan : index % 3 === 1 ? C.purple : C.mint,
          }}
        />
      );
    })}
  </div>
);

const AccessibilityScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const commands = [
    ["Read my latest message.", "Reading Maya's message."],
    ["Call Daniel.", "Calling Daniel."],
    ["Open my calendar.", "Calendar opened."],
  ];
  const active = Math.min(2, Math.floor(frame / 92));
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 330), fontFamily: font }}>
      <Backdrop dark>
        <div style={{ position: "absolute", left: 64, right: 64, top: 110, ...enter(frame, fps, 0) }}>
          <Kicker light>Accessibility is agency</Kicker>
          <div style={{ marginTop: 20, color: C.white, fontSize: 88, lineHeight: 1.01, fontWeight: 920 }}>
            A voice becomes
            <br />
            an action.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 278,
            top: 520,
            width: 525,
            height: 525,
            borderRadius: "50%",
            overflow: "hidden",
            ...scaleIn(frame, fps, 8),
          }}
        >
          <Img
            src={staticFile("eve-orb.jpg")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: "50%",
              mixBlendMode: "screen",
            }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 90,
            right: 90,
            top: 1090,
            padding: "34px 38px",
            background: "#ffffff0d",
            border: "1px solid #ffffff22",
            borderRadius: 28,
          }}
        >
          <div style={{ color: C.violet, fontSize: 19, fontWeight: 820, textTransform: "uppercase" }}>
            Listening
          </div>
          <div style={{ marginTop: 13, color: C.white, fontSize: 43, lineHeight: 1.15, fontWeight: 780 }}>
            {commands[active][0]}
          </div>
          <Waveform frame={frame} />
          <div
            style={{
              marginTop: 18,
              paddingTop: 22,
              borderTop: "1px solid #ffffff1f",
              color: "#c7c5ce",
              fontSize: 28,
              fontWeight: 620,
            }}
          >
            {commands[active][1]}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 80,
            right: 80,
            bottom: 110,
            color: "#c7c5ce",
            fontSize: 32,
            lineHeight: 1.35,
            fontWeight: 620,
            textAlign: "center",
            ...enter(frame, fps, 190, 28),
          }}
        >
          For anyone who needs another way to navigate a phone.
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const DesktopScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const laptop = spring({ frame: frame - 14, fps, config: { damping: 19, stiffness: 75 } });
  const tasks = [
    ["Email", "Reply drafted", C.purple],
    ["Files", "Documents organized", C.cyan],
    ["Calendar", "Appointment moved", C.mint],
  ] as const;
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 285), fontFamily: font }}>
      <Backdrop>
        <div style={{ position: "absolute", left: 64, right: 64, top: 95, ...enter(frame, fps, 0) }}>
          <Kicker>Beyond the phone</Kicker>
          <div style={{ marginTop: 18, color: C.ink, fontSize: 82, lineHeight: 1.02, fontWeight: 920 }}>
            The same voice.
            <br />
            Now across your computer.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 535,
            width: 920,
            opacity: laptop,
            transform: `translateY(${(1 - laptop) * 100}px)`,
          }}
        >
          <div
            style={{
              width: 920,
              height: 610,
              padding: 18,
              borderRadius: "34px 34px 18px 18px",
              background: C.ink,
              boxShadow: "0 40px 90px #1715262e",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                overflow: "hidden",
                borderRadius: 20,
                background: C.white,
              }}
            >
              <div
                style={{
                  height: 72,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 28px",
                  background: "#f1f0f5",
                  borderBottom: `1px solid ${C.line}`,
                }}
              >
                <div style={{ display: "flex", gap: 9 }}>
                  {[C.coral, "#e8b34d", C.mint].map((color) => (
                    <span
                      key={color}
                      style={{ width: 14, height: 14, borderRadius: "50%", background: color }}
                    />
                  ))}
                </div>
                <div style={{ color: C.gray, fontSize: 18, fontWeight: 720 }}>EVE DESKTOP</div>
                <div style={{ width: 64 }} />
              </div>
              <div style={{ padding: "35px" }}>
                <div style={{ color: C.gray, fontSize: 19, fontWeight: 720 }}>You said</div>
                <div style={{ marginTop: 10, color: C.ink, fontSize: 37, lineHeight: 1.15, fontWeight: 850 }}>
                  &ldquo;Clear my afternoon and send the updated brief.&rdquo;
                </div>
                <div
                  style={{ marginTop: 35, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 17 }}
                >
                  {tasks.map(([title, copy, color], index) => (
                    <div
                      key={title}
                      style={{
                        ...enter(frame, fps, 55 + index * 16, 38),
                        minHeight: 225,
                        padding: "25px 22px",
                        border: `1px solid ${C.line}`,
                        borderRadius: 18,
                        background: C.white,
                      }}
                    >
                      <div style={{ width: 42, height: 7, background: color }} />
                      <div style={{ marginTop: 28, color: C.gray, fontSize: 18, fontWeight: 740 }}>
                        {title}
                      </div>
                      <div
                        style={{
                          marginTop: 8,
                          color: C.ink,
                          fontSize: 26,
                          lineHeight: 1.12,
                          fontWeight: 850,
                        }}
                      >
                        {copy}
                      </div>
                      <div style={{ marginTop: 24, color, fontSize: 18, fontWeight: 800 }}>DONE</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div
            style={{
              width: 1000,
              height: 34,
              marginLeft: -40,
              background: "#bdbcc5",
              clipPath: "polygon(4% 0, 96% 0, 100% 100%, 0 100%)",
            }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 92,
            right: 92,
            top: 1280,
            display: "grid",
            gridTemplateColumns: "1fr 70px 1fr 70px 1fr",
            alignItems: "center",
            ...enter(frame, fps, 110, 34),
          }}
        >
          {["EVE", "OpenClaw", "Hermes"].map((label, index) => (
            <div key={label} style={{ display: "contents" }}>
              <div
                style={{
                  padding: "24px 15px",
                  borderRadius: 16,
                  background: index === 0 ? C.ink : C.white,
                  border: index === 0 ? "none" : `1px solid ${C.line}`,
                  color: index === 0 ? C.white : C.ink,
                  textAlign: "center",
                  fontSize: 25,
                  fontWeight: 850,
                }}
              >
                {label}
              </div>
              {index < 2 ? (
                <div style={{ textAlign: "center", color: C.purple, fontSize: 34, fontWeight: 900 }}>→</div>
              ) : null}
            </div>
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            left: 80,
            right: 80,
            bottom: 120,
            textAlign: "center",
            color: C.gray,
            fontSize: 30,
            lineHeight: 1.3,
            fontWeight: 620,
            ...enter(frame, fps, 160, 28),
          }}
        >
          Connected through OpenClaw and Hermes.
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const EndScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ opacity: fade(frame, 315, 10), fontFamily: font }}>
      <Backdrop dark>
        <div style={{ position: "absolute", left: 70, right: 70, top: 235, textAlign: "center" }}>
          <div
            style={{
              ...enter(frame, fps, 0, 65),
              color: C.white,
              fontSize: 96,
              lineHeight: 1.02,
              fontWeight: 930,
            }}
          >
            More independence.
          </div>
          <div
            style={{
              ...enter(frame, fps, 14, 65),
              marginTop: 20,
              color: C.violet,
              fontSize: 96,
              lineHeight: 1.02,
              fontWeight: 930,
            }}
          >
            Less worry.
          </div>
        </div>
        <div style={{ position: "absolute", left: 390, top: 710, ...scaleIn(frame, fps, 24) }}>
          <AppMark size={300} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 70,
            right: 70,
            top: 1080,
            textAlign: "center",
            ...enter(frame, fps, 38, 42),
          }}
        >
          <div style={{ color: C.white, fontSize: 124, lineHeight: 1, fontWeight: 950 }}>EVE</div>
          <div style={{ marginTop: 28, color: "#c7c5ce", fontSize: 36, lineHeight: 1.35, fontWeight: 620 }}>
            One assistant, across the people and devices that matter.
          </div>
          <div
            style={{
              margin: "62px auto 0",
              width: 650,
              padding: "26px 40px",
              border: `2px solid ${C.purple}`,
              color: C.white,
              fontSize: 28,
              fontWeight: 850,
              background: "#7656e81c",
            }}
          >
            MEET YOUR EVE
          </div>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

export type EvePromoProps = {
  renderAudio?: boolean;
};

export const EvePromo = ({ renderAudio = true }: EvePromoProps) => (
  <AbsoluteFill style={{ background: C.black }}>
    {renderAudio ? <Audio src={staticFile("eve-promo-audio.m4a")} volume={0.96} /> : null}
    <Sequence from={0} durationInFrames={120} premountFor={30}>
      <OpeningScene />
    </Sequence>
    <Sequence from={75} durationInFrames={300} premountFor={30}>
      <MomentsScene />
    </Sequence>
    <Sequence from={330} durationInFrames={210} premountFor={30}>
      <RevealScene />
    </Sequence>
    <Sequence from={495} durationInFrames={525} premountFor={30}>
      <ConnectedScene />
    </Sequence>
    <Sequence from={990} durationInFrames={330} premountFor={30}>
      <AccessibilityScene />
    </Sequence>
    <Sequence from={1170} durationInFrames={285} premountFor={30}>
      <DesktopScene />
    </Sequence>
    <Sequence from={1305} durationInFrames={315} premountFor={30}>
      <EndScene />
    </Sequence>
  </AbsoluteFill>
);
